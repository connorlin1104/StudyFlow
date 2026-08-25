'use strict';

/* =============================================================================
   FIREBASE — auth, firestore, storage; compat SDK (loaded via <script> tags)
   ============================================================================= */
firebase.initializeApp(window.FIREBASE_CONFIG);

const auth    = firebase.auth();
const storage = firebase.storage();
const db      = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;

// Safari (and some proxies/VPNs) fail the WebChannel streaming transport with a
// CORS "access control checks" error, so force long polling. Must run before any
// Firestore call. Costs nothing here — every read is a one-shot get(), no listeners.
db.settings({
  experimentalForceLongPolling:      true,
  experimentalAutoDetectLongPolling: false,
  merge:                             true
});
let currentUser = null;

let formAttachments = []; // { id, name, type, localUrl, url, storagePath, uploading, error }

/* =============================================================================
   FIRESTORE HELPERS
   Tabs, classes and homework talk to Firestore directly through the client SDK
   instead of the /api Cloud Functions backend, which is unavailable on the
   Spark plan. Access is scoped per-user by firestore.rules.
   ============================================================================= */
function requireUid() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not signed in');
  return uid;
}

const userCol  = name => db.collection('users').doc(requireUid()).collection(name);
const withId   = snap => ({ id: snap.id, ...snap.data() });
const readBack = async ref => withId(await ref.get());

// A batch caps out at 500 writes, so commit large deletes/reorders in chunks
const CHUNK = 450;

async function batchDelete(refs) {
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = db.batch();
    refs.slice(i, i + CHUNK).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

/* Persist a set of position (and parent) changes in one go.

   Each entry is `{ id, order, prev, data, critical }`. `order` is written only
   when it differs from `prev` — the order the doc already carries — so dropping
   an item into a 20-assignment group costs the two writes that actually moved
   rather than 20 against the Spark plan's daily cap. `data` rides along in the
   same batch, so a failure mid-flight can't strand an item in a new parent
   carrying a stale order. `critical` marks the docs the user actually acted on:
   those are the only failures worth surfacing.

   Positions come from the caller rather than an array index because a group's
   top level interleaves two collections — folders and loose assignments — so
   neither one's indices are contiguous. */
async function writeOrders(colName, entries) {
  const col    = userCol(colName);
  const byId   = new Map();
  const writes = [];
  for (const e of entries) {
    let w = byId.get(e.id);
    if (!w) { w = { id: e.id, ref: col.doc(e.id), data: {}, critical: false }; byId.set(e.id, w); writes.push(w); }
    if (e.order !== undefined && e.order !== e.prev) w.data.order = e.order;
    if (e.data) Object.assign(w.data, e.data);
    if (e.critical) w.critical = true;
  }
  const live = writes.filter(w => Object.keys(w.data).length);

  for (let i = 0; i < live.length; i += CHUNK) {
    const slice = live.slice(i, i + CHUNK);
    const batch = db.batch();
    slice.forEach(w => batch.update(w.ref, w.data));
    try {
      await batch.commit();
    } catch (err) {
      // A single doc deleted on another device fails the whole batch. Retry the
      // slice one write at a time so the survivors still land, and only surface
      // the error if a doc the user actually moved is the one that failed.
      const results = await Promise.allSettled(slice.map(w => w.ref.update(w.data)));
      const bad = results.findIndex((r, j) => r.status === 'rejected' && slice[j].critical);
      if (bad !== -1) throw results[bad].reason;
      if (!slice.some(w => w.critical) && results.every(r => r.status === 'rejected')) throw err;
    }
  }
  return { ok: true };
}

/* Contiguous-index flavour of writeOrders, for lists that live in one collection
   (spaces, and the settings-panel reorders). */
function writeOrder(colName, orderedIds, { prevOrders, moved } = {}) {
  if (!Array.isArray(orderedIds)) throw new Error('order must be an array of IDs');
  const entries = orderedIds.map((id, i) => ({
    id, order: i,
    prev:     prevOrders ? prevOrders.get(id) : undefined,
    data:     moved && moved.id === id ? moved.data : null,
    critical: !!(moved && moved.id === id)
  }));
  // A parent change must never be dropped just because that doc isn't in the list
  if (moved && !orderedIds.includes(moved.id)) {
    entries.push({ id: moved.id, data: { ...moved.data }, critical: true });
  }
  return writeOrders(colName, entries);
}

// 'in' accepts at most 10 values per query
async function refsForClasses(colName, classIds) {
  const refs = [];
  for (let i = 0; i < classIds.length; i += 10) {
    const snap = await userCol(colName).where('classId', 'in', classIds.slice(i, i + 10)).get();
    snap.docs.forEach(d => refs.push(d.ref));
  }
  return refs;
}

// Rules only permit reading push subscriptions filtered by the owner's uid
const subsFor = uid => db.collection('pushSubscriptions').where('uid', '==', uid);

// Best-effort: a missing/undeletable file must not block the Firestore write
async function deleteAttachments(attachments) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(a => a?.storagePath);
  if (!files.length) return;
  await Promise.allSettled(files.map(a => storage.ref(a.storagePath).delete()));
}

/* =============================================================================
   DATA LAYER
   ============================================================================= */
const api = {
  tabs: {
    async list() {
      const snap = await userCol('tabs').get();
      return snap.docs.map(withId).sort((a, b) => {
        if (a.order != null && b.order != null) return a.order - b.order;
        if (a.order != null) return -1;
        if (b.order != null) return 1;
        return (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0);
      });
    },
    async create({ name }) {
      if (!name?.trim()) throw new Error('name is required');
      const ref = await userCol('tabs').add({
        name:      name.trim(),
        type:      'custom',
        createdAt: FieldValue.serverTimestamp()
      });
      return { id: ref.id, name: name.trim(), type: 'custom' };
    },
    async update(id, { name }) {
      const ref = userCol('tabs').doc(id);
      await ref.update({ name });
      return readBack(ref);
    },
    async remove(id) {
      const clsSnap = await userCol('classes').where('tabId', '==', id).get();
      const clsIds  = clsSnap.docs.map(d => d.id);
      const hwRefs  = clsIds.length ? await refsForClasses('homework', clsIds) : [];
      const fdRefs  = clsIds.length ? await refsForClasses('folders',  clsIds) : [];
      await batchDelete([userCol('tabs').doc(id), ...clsSnap.docs.map(d => d.ref), ...fdRefs, ...hwRefs]);
      return { ok: true };
    },
    reorder(orderedIds, opts) { return writeOrder('tabs', orderedIds, opts); }
  },

  classes: {
    async list() {
      const snap = await userCol('classes').get();
      return snap.docs.map(withId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async create({ name, color, teacher, room, period, tabId }) {
      if (!name?.trim()) throw new Error('name is required');
      const data = {
        tabId:     tabId || 'classes',
        name:      name.trim(),
        color:     color || '#3b82f6',
        order:     Date.now(),
        createdAt: FieldValue.serverTimestamp()
      };
      if (teacher) data.teacher = teacher;
      if (room)    data.room    = room;
      if (period)  data.period  = period;
      return readBack(await userCol('classes').add(data));
    },
    async update(id, { name, color, teacher, room, period, tabId }) {
      const ref    = userCol('classes').doc(id);
      const update = {};
      if (name    !== undefined) update.name    = name;
      if (color   !== undefined) update.color   = color;
      if (tabId   !== undefined) update.tabId   = tabId;
      if (teacher !== undefined) update.teacher = teacher || FieldValue.delete();
      if (room    !== undefined) update.room    = room    || FieldValue.delete();
      if (period  !== undefined) update.period  = period  || FieldValue.delete();
      if (Object.keys(update).length) await ref.update(update);
      return readBack(ref);
    },
    async remove(id) {
      const hwSnap = await userCol('homework').where('classId', '==', id).get();
      const fdSnap = await userCol('folders').where('classId', '==', id).get();
      await batchDelete([userCol('classes').doc(id), ...fdSnap.docs.map(d => d.ref), ...hwSnap.docs.map(d => d.ref)]);
      return { ok: true };
    },
    reorder(orderedIds, opts) { return writeOrder('classes', orderedIds, opts); }
  },

  /* Folders are mini-groups inside a group: a labelled box that holds a subset
     of a group's assignments and moves as a single unit. A folder and the loose
     assignments beside it share one `order` sequence — the group's top level —
     while the assignments inside a folder number themselves 0..n-1 within it.

     Unlike everything else here, create() takes the id it should write to. Undo
     of a folder delete has to bring the *same* id back, because every assignment
     that was inside it still points at that id through `folderId`. */
  folders: {
    async list() {
      const snap = await userCol('folders').get();
      return snap.docs.map(withId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    newId() { return userCol('folders').doc().id; },
    async create({ id, classId, name, order }) {
      if (!classId) throw new Error('classId is required');
      const data = {
        classId,
        name:      (name || 'New Folder').trim() || 'New Folder',
        order:     order ?? 0,
        createdAt: FieldValue.serverTimestamp()
      };
      const ref = id ? userCol('folders').doc(id) : userCol('folders').doc();
      await ref.set(data);
      return { id: ref.id, ...data };
    },
    async update(id, { name, classId, order }) {
      const ref    = userCol('folders').doc(id);
      const update = {};
      if (name    !== undefined) update.name    = name;
      if (classId !== undefined) update.classId = classId;
      if (order   !== undefined) update.order   = order;
      if (Object.keys(update).length) await ref.update(update);
      return readBack(ref);
    },
    // Only the label. Whoever calls this decides what happens to the contents —
    // disband clears their folderId, delete removes them alongside it.
    async remove(id) {
      await userCol('folders').doc(id).delete();
      return { ok: true };
    }
  },

  homework: {
    async list(classId) {
      let query = userCol('homework');
      if (classId) query = query.where('classId', '==', classId);
      const snap = await query.get();
      return snap.docs.map(withId);
    },
    // `completed`/`completedAt` are accepted so undoing a delete restores an
    // assignment in the state it was deleted in, rather than resurrecting it
    // as active. They default to a fresh, incomplete assignment.
    async create({ classId, folderId, description, notes, deadline, deadlineTime, deadlineMs, remindBefore, attachments, completed, completedAt, order }) {
      if (!classId || !description?.trim()) throw new Error('classId and description are required');
      const data = {
        classId,
        description: description.trim(),
        completed:   !!completed,
        createdAt:   FieldValue.serverTimestamp()
      };
      if (folderId) data.folderId = folderId;
      if (order != null) data.order = order;
      if (completed) data.completedAt = completedAt ?? FieldValue.serverTimestamp();
      if (notes)        data.notes        = notes;
      if (deadline)     data.deadline     = deadline;
      if (deadlineTime) data.deadlineTime = deadlineTime;
      if (remindBefore !== undefined && remindBefore !== null) data.remindBefore = remindBefore;
      if (deadlineMs != null) data.deadlineMs = deadlineMs;
      if (Array.isArray(attachments) && attachments.length) data.attachments = attachments;
      return readBack(await userCol('homework').add(data));
    },
    async update(id, { classId, folderId, description, notes, deadline, deadlineTime, deadlineMs, completed, remindBefore, attachments }) {
      const ref      = userCol('homework').doc(id);
      const existing = (await ref.get()).data() || {};
      const update   = {};
      if (classId      !== undefined) update.classId      = classId;
      if (folderId     !== undefined) update.folderId     = folderId || null;
      if (description  !== undefined) update.description  = description;
      if (notes        !== undefined) update.notes        = notes;
      if (deadline     !== undefined) update.deadline     = deadline;
      if (deadlineTime !== undefined) update.deadlineTime = deadlineTime;
      if (completed    !== undefined) {
        update.completed   = completed;
        update.completedAt = completed ? FieldValue.serverTimestamp() : null;
        if (completed && !existing.completed && existing.attachments?.length) {
          await deleteAttachments(existing.attachments);
          update.attachments = [];
        }
      }
      if (remindBefore !== undefined) update.remindBefore = remindBefore;
      if (deadlineMs   !== undefined) update.deadlineMs   = deadlineMs;
      if (attachments  !== undefined) update.attachments  = Array.isArray(attachments) ? attachments : [];
      if ((deadline     !== undefined && deadline     !== existing.deadline) ||
          (deadlineTime !== undefined && deadlineTime !== existing.deadlineTime)) {
        update.remindedAt = null;
      }
      if (Object.keys(update).length) await ref.update(update);
      return readBack(ref);
    },
    async remove(id) {
      const ref = userCol('homework').doc(id);
      await deleteAttachments((await ref.get()).data()?.attachments);
      await ref.delete();
      return { ok: true };
    },
    reorder(orderedIds, opts) { return writeOrder('homework', orderedIds, opts); }
  },

  // notifyBefore is shared across devices: one userPrefs doc per user, mirrored
  // onto every push subscription. Both live outside users/{uid}, so they have
  // their own rules in firestore.rules.
  notifications: {
    async getPrefs() {
      const uid = requireUid();
      const doc = await db.collection('userPrefs').doc(uid).get();
      if (doc.exists && doc.data().notifyBefore != null) return { notifyBefore: doc.data().notifyBefore };
      // Migration fallback: read from the first subscription
      const snap = await subsFor(uid).limit(1).get();
      return { notifyBefore: snap.empty ? 60 : (snap.docs[0].data().notifyBefore ?? 60) };
    },
    async setPrefs(notifyBefore) {
      if (notifyBefore == null) throw new Error('notifyBefore required');
      const uid = requireUid();
      await db.collection('userPrefs').doc(uid).set({ notifyBefore }, { merge: true });
      const snap = await subsFor(uid).get();
      await Promise.all(snap.docs.map(d => d.ref.update({ notifyBefore })));
      return { ok: true };
    },
    async subscribe(subscription, notifyBefore) {
      if (!subscription?.endpoint || !subscription?.keys) throw new Error('subscription object required');
      const uid  = requireUid();
      const snap = await subsFor(uid).where('endpoint', '==', subscription.endpoint).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ notifyBefore: notifyBefore ?? 60 });
        return { id: snap.docs[0].id };
      }
      const ref = await db.collection('pushSubscriptions').add({
        uid,
        endpoint:     subscription.endpoint,
        keys:         subscription.keys,
        notifyBefore: notifyBefore ?? 60,
        createdAt:    FieldValue.serverTimestamp()
      });
      return { id: ref.id };
    },
    async unsubscribe(endpoint) {
      if (!endpoint) throw new Error('endpoint required');
      const snap = await subsFor(requireUid()).where('endpoint', '==', endpoint).limit(1).get();
      await Promise.all(snap.docs.map(d => d.ref.delete()));
      return { ok: true };
    }
  }
};

/* =============================================================================
   STATE
   ============================================================================= */
const state = {
  tabs:        [],
  activeTabId: 'classes',
  classes:     [],
  folders:     [],
  homework:    []
};

/* Groups are rendered in array order, but the server sorts `classes` by `order`
   alone — which interleaves spaces, since each space numbers its own groups from
   zero. Re-sort by (space, order) after every load or move. */
function resortClasses() {
  state.classes.sort((a, b) => {
    const ta = state.tabs.findIndex(t => t.id === a.tabId);
    const tb = state.tabs.findIndex(t => t.id === b.tabId);
    return (ta - tb) || ((a.order ?? 9999) - (b.order ?? 9999));
  });
}

/* -----------------------------------------------------------------------------
   BOARD SHAPE

   A group's top level holds folders and loose assignments in one shared `order`
   sequence; a folder holds assignments in its own sequence. Both lists are
   normalised to `{ type, id, ref }` so drag, move and reorder never have to care
   which of the two collections an entry came from.
   ----------------------------------------------------------------------------- */
function deadlineValue(hw) {
  if (!hw?.deadline) return Infinity;
  return new Date(hw.deadline + (hw.deadlineTime ? `T${hw.deadlineTime}` : 'T23:59')).getTime();
}

function groupChildren(classId) {
  const items = [
    ...state.folders
      .filter(f => f.classId === classId)
      .map(f => ({ type: 'fd', id: f.id, ref: f, order: f.order ?? null, due: Infinity })),
    ...state.homework
      .filter(h => h.classId === classId && !h.completed && !h.folderId)
      .map(h => ({ type: 'hw', id: h.id, ref: h, order: h.order ?? null, due: deadlineValue(h) }))
  ];
  return sortChildren(items);
}

function folderChildren(folderId) {
  return sortChildren(state.homework
    .filter(h => h.folderId === folderId && !h.completed)
    .map(h => ({ type: 'hw', id: h.id, ref: h, order: h.order ?? null, due: deadlineValue(h) })));
}

/* Manual order wins once anything in the list has one; until then the list falls
   back to deadline order, which is how a brand-new group sorts itself. */
function sortChildren(items) {
  const hasManual = items.some(i => i.order != null);
  return items.sort((a, b) => {
    if (hasManual) {
      if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
      if (a.order != null && b.order == null) return -1;
      if (a.order == null && b.order != null) return 1;
    }
    if (a.due !== b.due) return a.due - b.due;
    // Ties have to break the same way every render, or items jitter between them
    return a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.type === 'fd' ? -1 : 1);
  });
}

function containerItems(classId, folderId) {
  return folderId ? folderChildren(folderId) : groupChildren(classId);
}

/* Selection keys name a thing on the board across re-renders: `hw:`, `fd:`, `cls:`. */
const KEY_PREFIX = { hw: 'hw:', folder: 'fd:', fd: 'fd:', class: 'cls:', cls: 'cls:' };
function selKey(type, id) { return KEY_PREFIX[type] + id; }
function splitKey(key)    { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; }
function keyKind(key)     { return key.startsWith('cls:') ? 'class' : 'item'; }

/* =============================================================================
   MULTI-SELECT

   Ctrl/Cmd-click adds one thing to the selection and leaves the rest alone;
   Shift-click takes everything between the anchor and the click. A selection
   only ever holds one kind at a time — groups, or board items (assignments and
   folders, which share a group's ordering) — because the two move through
   different code and can't be dragged as one pile.

   Ranges are read off the DOM rather than off state, so "everything in between"
   means everything the user can actually see: a collapsed group or folder hides
   its contents from the range, which is what it looks like it should do.
   ============================================================================= */
const sel = { kind: null, ids: new Set(), anchor: null };

function selectionKeys(kind = sel.kind) {
  if (!sel.ids.size) return [];
  const visible = visibleSelKeys(kind).filter(k => sel.ids.has(k));
  const rest    = [...sel.ids].filter(k => !visible.includes(k));
  return [...visible, ...rest];
}

function visibleSelKeys(kind) {
  const q = kind === 'class'
    ? '#classes-container .class-row'
    : '#classes-container .folder, #classes-container .hw-item';
  return [...document.querySelectorAll(q)]
    .filter(el => el.offsetParent !== null)
    .map(el => el.classList.contains('class-row') ? selKey('cls', el.dataset.classId)
              : el.classList.contains('folder')   ? selKey('fd',  el.dataset.folderId)
              : selKey('hw', el.dataset.hwId));
}

function elementForKey(key) {
  const [type, id] = splitKey(key);
  const q = type === 'hw'  ? `.hw-item[data-hw-id="${CSS.escape(id)}"]`
          : type === 'fd'  ? `.folder[data-folder-id="${CSS.escape(id)}"]`
          :                  `.class-row[data-class-id="${CSS.escape(id)}"]`;
  return document.querySelector(`#classes-container ${q}`);
}

function selectionExists(key) {
  const [type, id] = splitKey(key);
  if (type === 'hw')  return state.homework.some(h => h.id === id);
  if (type === 'fd')  return state.folders.some(f => f.id === id);
  return state.classes.some(c => c.id === id);
}

function clearSelection() {
  if (!sel.ids.size && !sel.kind) return;
  sel.ids.clear(); sel.kind = null; sel.anchor = null;
  applySelectionStyles();
}

function handleSelectClick(key, mod, shift) {
  const kind = keyKind(key);
  if (sel.kind !== kind) { sel.ids.clear(); sel.kind = kind; sel.anchor = null; }

  const all = visibleSelKeys(kind);
  const from = sel.anchor ? all.indexOf(sel.anchor) : -1;
  const to   = all.indexOf(key);

  if (shift && from !== -1 && to !== -1) {
    if (!mod) sel.ids.clear();
    all.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(k => sel.ids.add(k));
  } else if (mod || shift) {
    // Ctrl/Cmd toggles; a Shift-click with nothing to reach back to starts the range
    if (mod && sel.ids.has(key)) sel.ids.delete(key);
    else sel.ids.add(key);
    sel.anchor = key;
  }
  if (!sel.ids.size) { sel.kind = null; sel.anchor = null; }
  applySelectionStyles();
}

/* Selection survives re-renders, so it has to be re-painted after each one and
   pruned of anything that has since been deleted. */
function applySelectionStyles() {
  [...sel.ids].forEach(k => { if (!selectionExists(k)) sel.ids.delete(k); });
  if (!sel.ids.size) { sel.kind = null; sel.anchor = null; }
  document.querySelectorAll('#classes-container .sel-active')
    .forEach(el => el.classList.remove('sel-active'));
  sel.ids.forEach(key => elementForKey(key)?.classList.add('sel-active'));
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = document.getElementById('selection-bar');
  if (!bar) return;
  const n = sel.ids.size;
  bar.classList.toggle('hidden', n < 2);
  if (n < 2) return;
  const noun = sel.kind === 'class' ? 'group' : 'item';
  document.getElementById('selection-count').textContent = `${n} ${noun}${n === 1 ? '' : 's'} selected`;
}

/* =============================================================================
   UNDO / REDO HISTORY (max 30 entries)
   ============================================================================= */
const CANCELLED = '__undo_cancelled__';

const history = {
  past:   [],
  future: [],
  _busy:  false,
  push(action) {
    this.past.push(action);
    if (this.past.length > 30) this.past.shift();
    this.future = [];
    updateHistoryBtns();
  },
  async undo() {
    if (!this.past.length || this._busy) return;
    const action = this.past[this.past.length - 1];
    this._busy = true; updateHistoryBtns();
    // Leave the entry on the stack if the undo fails or the user backs out of a
    // confirmation, so Ctrl+Z can be tried again instead of silently burning it.
    try { await action.undo(); }
    catch (err) { if (err?.message !== CANCELLED) toast(`Undo failed: ${err.message}`, 'error'); return; }
    finally { this._busy = false; updateHistoryBtns(); }
    this.past.pop();
    this.future.push(action);
    updateHistoryBtns();
  },
  async redo() {
    if (!this.future.length || this._busy) return;
    const action = this.future[this.future.length - 1];
    this._busy = true; updateHistoryBtns();
    try { await action.redo(); }
    catch (err) { if (err?.message !== CANCELLED) toast(`Redo failed: ${err.message}`, 'error'); return; }
    finally { this._busy = false; updateHistoryBtns(); }
    this.future.pop();
    this.past.push(action);
    updateHistoryBtns();
  }
};

function updateHistoryBtns() {
  document.getElementById('undo-btn').disabled = history._busy || history.past.length === 0;
  document.getElementById('redo-btn').disabled = history._busy || history.future.length === 0;
}

/* =============================================================================
   PREFERENCES (persisted to localStorage)
   ============================================================================= */
const ACCENT_OPTIONS = [
  { label: 'Blue',   value: '#3b82f6', hover: '#2563eb' },
  { label: 'Indigo', value: '#6366f1', hover: '#4f46e5' },
  { label: 'Purple', value: '#8b5cf6', hover: '#7c3aed' },
  { label: 'Rose',   value: '#f43f5e', hover: '#e11d48' },
  { label: 'Orange', value: '#f97316', hover: '#ea580c' },
  { label: 'Green',  value: '#22c55e', hover: '#16a34a' },
  { label: 'Teal',   value: '#14b8a6', hover: '#0d9488' },
];

const prefs = {
  _data: JSON.parse(localStorage.getItem('sf-prefs') || '{}'),
  get(key, def) { return key in this._data ? this._data[key] : def; },
  set(key, val) { this._data[key] = val; localStorage.setItem('sf-prefs', JSON.stringify(this._data)); }
};

function applyPrefs() {
  const theme = prefs.get('theme', 'light');
  document.documentElement.setAttribute('data-theme', theme);

  const accent = ACCENT_OPTIONS.find(a => a.value === prefs.get('accent', '#3b82f6')) || ACCENT_OPTIONS[0];
  document.documentElement.style.setProperty('--primary', accent.value);
  document.documentElement.style.setProperty('--primary-hover', accent.hover);

  document.body.classList.toggle('pref-compact', prefs.get('compact', false));

  const showSummary = prefs.get('showSummary', true);
  const panel = document.querySelector('.summary-panel');
  if (panel) panel.classList.toggle('summary-panel--collapsed', !showSummary);
}

/* =============================================================================
   CONSTANTS
   ============================================================================= */
const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
];

// Module-level drag state for settings reorder
let _draggedClassId = null;
let _draggedTabId   = null;
let _draggedHwId    = null;

// Returns the first preset color not yet used in the given tab
function getNextAvailableColor(tabId) {
  const used = new Set(state.classes.filter(c => c.tabId === tabId).map(c => c.color));
  return PRESET_COLORS.find(c => !used.has(c)) ?? PRESET_COLORS[0];
}

// Returns "an" if word starts with a vowel sound, otherwise "a"
function article(word) {
  return /^[aeiouAEIOU]/.test(word) ? 'an' : 'a';
}

// Basic singularizer: "Clubs" → "Club", "Activities" → "Activity", "Classes" → "Class"
function singularize(name) {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (/[sx]es$/.test(name) || name.endsWith('ches') || name.endsWith('shes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

/* =============================================================================
   UTILITIES
   ============================================================================= */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizePeriod(raw) {
  if (!raw?.trim()) return raw;
  const s = raw.trim();
  const WORD_MAP = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12
  };
  function ordinal(n) {
    if ([11,12,13].includes(n%100)) return `${n}th`;
    const r = n%10;
    if (r===1) return `${n}st`;
    if (r===2) return `${n}nd`;
    if (r===3) return `${n}rd`;
    return `${n}th`;
  }
  const stripped = s.replace(/^\bperiod\b\s*/i,'').replace(/\s*\bperiod\b$/i,'').trim();
  const numMatch = stripped.match(/^(\d+)(st|nd|rd|th)?$/i);
  if (numMatch) { const n = parseInt(numMatch[1],10); if (n>=1 && n<=20) return `${ordinal(n)} Period`; }
  const lower = stripped.toLowerCase();
  if (WORD_MAP[lower] !== undefined) return `${ordinal(WORD_MAP[lower])} Period`;
  return s;
}

function parseDeadline(dateStr, timeStr) {
  if (!dateStr) return null;
  const due   = new Date(dateStr + (timeStr ? `T${timeStr}:00` : 'T00:00:00'));
  const today = new Date();
  today.setHours(0,0,0,0);
  const diff  = Math.floor((due-today)/86_400_000);
  let label;
  if (diff === 0)       label = 'Today';
  else if (diff === 1)  label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else label = due.toLocaleDateString('en-US', {
    month:'short', day:'numeric',
    ...(due.getFullYear()!==today.getFullYear() && {year:'numeric'})
  });
  if (timeStr) {
    label += ' at ' + due.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  }
  // Overdue if past the deadline date, or same day but the time has already passed
  const overdue = diff < 0 || (diff === 0 && due < new Date());
  const cssClass = overdue          ? 'deadline--overdue'
                 : diff === 0       ? 'deadline--today'
                 : diff <= 3        ? 'deadline--soon'
                 : 'deadline--ok';
  return { label: `Due ${label}`, diff, cssClass };
}

function deadlineCssClass(diff) {
  if (diff===null||diff===undefined) return '';
  if (diff<0)   return 'deadline--overdue';
  if (diff===0) return 'deadline--today';
  if (diff<=3)  return 'deadline--soon';
  return 'deadline--ok';
}

/* =============================================================================
   TOAST
   ============================================================================= */
function toast(message, type='info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--show'));
  setTimeout(() => {
    el.classList.remove('toast--show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 3500);
}

/* =============================================================================
   CUSTOM CONFIRM DIALOG
   ============================================================================= */
function showConfirm({ title, message = '', confirmText = 'Delete', confirmClass = 'btn-danger', icon = '🗑️' }) {
  return new Promise(resolve => {
    const dialog     = document.getElementById('confirm-dialog');
    const titleEl    = document.getElementById('confirm-title');
    const messageEl  = document.getElementById('confirm-message');
    const iconEl     = document.getElementById('confirm-icon');
    const okBtn      = document.getElementById('confirm-ok');
    const cancelBtn  = document.getElementById('confirm-cancel');
    const backdrop   = document.getElementById('confirm-backdrop');

    titleEl.textContent   = title;
    iconEl.textContent    = icon;
    okBtn.textContent     = confirmText;
    okBtn.className       = `btn ${confirmClass}`;

    if (message) {
      messageEl.textContent = message;
      messageEl.classList.remove('hidden');
    } else {
      messageEl.classList.add('hidden');
    }

    dialog.classList.add('modal--open');
    cancelBtn.focus();

    function cleanup(result) {
      dialog.classList.remove('modal--open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

/* =============================================================================
   RENDER — TAB BAR
   ============================================================================= */
function renderTabBar() {
  const list = document.getElementById('tab-list');
  list.innerHTML = '';
  state.tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = `tab${tab.id===state.activeTabId ? ' tab--active' : ''}`;
    btn.dataset.tabId = tab.id;
    btn.textContent = tab.name;
    btn.addEventListener('click', () => setActiveTab(tab.id));
    list.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'tab tab--add';
  addBtn.title = 'Add or manage spaces';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => openSettings('tabs'));
  list.appendChild(addBtn);
}

function setActiveTab(tabId) {
  state.activeTabId = tabId;
  // A drag switches spaces to carry the held items across, so the selection it
  // is carrying has to survive that; a plain space switch drops it.
  if (!document.body.classList.contains('is-dragging')) clearSelection();
  renderTabBar();
  renderSchedule();
}

/* =============================================================================
   RENDER — MAIN SCHEDULE
   ============================================================================= */
function renderSchedule() {
  const container  = document.getElementById('classes-container');
  const emptyState = document.getElementById('empty-state');

  const tabClasses = state.classes.filter(c => c.tabId === state.activeTabId);
  if (tabClasses.length === 0) {
    container.innerHTML = '';
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    const welcomeActions = document.getElementById('empty-actions-welcome');
    const tabActions     = document.getElementById('empty-actions-tab');
    if (!activeTab) {
      document.getElementById('empty-heading').textContent  = 'Welcome to StudyFlow';
      document.getElementById('empty-subtext').textContent  = 'Pick a template to get started, or set things up yourself.';
      welcomeActions.classList.remove('hidden');
      tabActions.classList.add('hidden');
    } else {
      const name = activeTab.name;
      document.getElementById('empty-heading').textContent  = `No ${name.toLowerCase()} yet`;
      document.getElementById('empty-subtext').textContent  = `Open Settings to add topics to this space`;
      welcomeActions.classList.add('hidden');
      tabActions.classList.remove('hidden');
    }
    emptyState.classList.remove('hidden');
    applySelectionStyles();
    return;
  }
  emptyState.classList.add('hidden');
  container.innerHTML = '';
  tabClasses.forEach(cls => {
    const row = buildClassRow(cls);
    addClassDragBehavior(row, cls, container);
    container.appendChild(row);
  });

  const addTopicWrap = document.createElement('div');
  addTopicWrap.className = 'add-topic-wrap';
  const addTopicBtn = document.createElement('button');
  addTopicBtn.className = 'btn btn-primary add-topic-btn';
  addTopicBtn.textContent = '+ Add New Group';
  addTopicBtn.addEventListener('click', () => {
    populateSettingsTabSelect(state.activeTabId);
    resetClassForm();
    openGroupForm();
  });
  addTopicWrap.appendChild(addTopicBtn);
  container.appendChild(addTopicWrap);
  applySelectionStyles();
}

function buildClassRow(cls) {
  const pendingHw    = state.homework.filter(h => h.classId === cls.id && !h.completed);
  const collapsedIds = prefs.get('collapsedTopics', []);
  const startCollapsed = Array.isArray(collapsedIds) && collapsedIds.includes(cls.id);

  const row = document.createElement('div');
  row.className = `class-row${startCollapsed ? ' class-row--collapsed' : ''}`;
  row.dataset.classId = cls.id;
  row.style.setProperty('--color', cls.color || '#94a3b8');

  const details  = [cls.teacher, cls.room, cls.period].filter(Boolean).join(' · ');
  const badgeHtml = pendingHw.length > 0
    ? `<span class="badge badge--pending">${pendingHw.length} pending</span>`
    : `<span class="badge badge--done">All done ✓</span>`;

  row.innerHTML = `
    <div class="class-header">
      <span class="class-drag-handle" title="Drag to reorder group">⠿</span>
      <button class="class-toggle-btn" aria-label="Toggle topic" aria-expanded="${!startCollapsed}">${startCollapsed ? '▸' : '▾'}</button>
      <div class="class-meta">
        <span class="class-name-text">${esc(cls.name)}</span>
        ${details ? `<span class="class-details-text">${esc(details)}</span>` : ''}
      </div>
      <div class="class-header-right">
        <button class="class-add-hw-btn" data-class-id="${cls.id}">+ Add</button>
        <div class="class-badge-area">${badgeHtml}</div>
      </div>
    </div>
    <div class="hw-list" id="hw-list-${cls.id}"></div>
  `;

  const hwList   = row.querySelector('.hw-list');
  const children = groupChildren(cls.id);
  if (children.length === 0) {
    hwList.innerHTML = `<div class="hw-empty">No pending assignments ✓</div>`;
  } else {
    children.forEach(child => hwList.appendChild(
      child.type === 'fd' ? buildFolder(child.ref) : buildHwItem(child.ref, true)
    ));
  }
  return row;
}

/* A folder — a labelled box of assignments living inside a group. It sits in the
   group's own ordering next to loose assignments, and drags as one piece. */
function buildFolder(folder) {
  const collapsed = new Set(prefs.get('collapsedFolders', [])).has(folder.id);
  const kids      = folderChildren(folder.id);

  const el = document.createElement('div');
  el.className = `folder${collapsed ? ' folder--collapsed' : ''}`;
  el.dataset.folderId = folder.id;
  el.innerHTML = `
    <div class="folder-header">
      <span class="folder-drag-handle" title="Drag to move folder">⠿</span>
      <button class="folder-toggle-btn" aria-label="Toggle folder" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
      <span class="folder-icon" aria-hidden="true">${collapsed ? '📁' : '📂'}</span>
      <span class="folder-name">${esc(folder.name)}</span>
      <span class="folder-count">${kids.length}</span>
      <button class="folder-add-btn" data-folder-id="${folder.id}" title="Add assignment to this folder">+ Add</button>
    </div>
    <div class="folder-items"></div>
  `;

  const box = el.querySelector('.folder-items');
  if (!kids.length) {
    box.innerHTML = `<div class="folder-empty">Empty — drag assignments in</div>`;
  } else {
    kids.forEach(child => box.appendChild(buildHwItem(child.ref, true)));
  }
  attachDrag(el, 'folder', folder.id);
  return el;
}

/* =============================================================================
   UNIFIED DRAG-AND-DROP  (pointer-based: mouse + touch + pen, handle-only)

   A clone follows the cursor (so items visibly move, not just fade). Supports:
     • reorder assignments within a group or a folder
     • move an assignment into another group or folder (any space)
     • reorder groups within a space
     • drag a folder — its assignments travel with it as one piece
     • cross-space moves — drag over the top space bar to switch spaces, then
       drop the held item into the target space.
     • dragging anything that is part of the current multi-selection drags the
       whole selection.
   Settings-panel reorder still uses its own native DnD (separate code path).
   ============================================================================= */
const DRAG = {
  hw: {
    handle: '.hw-drag-handle', item: '.hw-item', dataSel: 'data-hw-id',
    dragCls: 'hw-dragging', cloneCls: 'hw-drag-clone',
  },
  folder: {
    handle: '.folder-drag-handle', item: '.folder', dataSel: 'data-folder-id',
    dragCls: 'folder-dragging', cloneCls: 'folder-drag-clone',
  },
  class: {
    handle: '.class-drag-handle', item: '.class-row', dataSel: 'data-class-id',
    dragCls: 'class-dragging', cloneCls: 'class-drag-clone',
  },
};

// Thin wrapper keeps the existing render call-site unchanged.
function addClassDragBehavior(row, cls) { attachDrag(row, 'class', cls.id); }

function nodeFor(type, id) {
  const cfg = DRAG[type];
  return document.querySelector(`${cfg.item}[${cfg.dataSel}="${CSS.escape(id)}"]`);
}

function clearDropHighlights() {
  document.querySelectorAll('.hw-drag-over, .class-drag-over, .tab--drop, .group-drop-target, .folder-drop-target')
    .forEach(el => el.classList.remove('hw-drag-over', 'class-drag-over', 'tab--drop', 'group-drop-target', 'folder-drop-target'));
}

function attachDrag(node, type, id) {
  const cfg = DRAG[type];
  // A folder's handle sits in its header; querySelector would otherwise find a
  // child assignment's handle in a nested list.
  const handle = type === 'folder'
    ? node.querySelector('.folder-header > .folder-drag-handle')
    : node.querySelector(cfg.handle);
  if (!handle) return;
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
    e.preventDefault();
    e.stopPropagation();
    startPointerDrag(e, type, id);
  });
}

/* What this drag is actually carrying: the whole selection when the grabbed
   thing is part of it, otherwise just the grabbed thing (and the selection goes
   away, the same as a plain click on it would do). */
function dragPayload(type, id) {
  const key  = selKey(type, id);
  const kind = type === 'class' ? 'class' : 'item';
  if (sel.kind === kind && sel.ids.has(key)) {
    const keys = selectionKeys(kind);
    // Grabbed item first, so "moved N back" toasts and focus name the right one
    return { kind, keys: [key, ...keys.filter(k => k !== key)], primary: key };
  }
  clearSelection();
  return { kind, keys: [key], primary: key };
}

function startPointerDrag(down, type, id) {
  const cfg = DRAG[type];
  const pid = down.pointerId;
  const sx = down.clientX, sy = down.clientY;
  const payload = dragPayload(type, id);
  let started = false, clone = null, offX = 0, offY = 0, lastTab = null;

  const move = ev => {
    if (ev.pointerId !== pid) return;

    if (!started) {
      if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
      started = true;
      const src  = nodeFor(type, id);
      const rect = (src || document.body).getBoundingClientRect();
      offX = ev.clientX - rect.left;
      offY = ev.clientY - rect.top;
      clone = (src || document.createElement('div')).cloneNode(true);
      clone.classList.add(cfg.cloneCls);
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;margin:0;z-index:9999;pointer-events:none;opacity:.92;box-shadow:0 10px 28px rgba(0,0,0,.22);border-radius:10px;`;
      if (payload.keys.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'drag-count-badge';
        badge.textContent = payload.keys.length;
        clone.appendChild(badge);
      }
      document.body.appendChild(clone);
      payload.keys.forEach(k => elementForKey(k)?.classList.add(cfg.dragCls, 'drag-source'));
      if (src) src.classList.add(cfg.dragCls);
      document.body.classList.add('is-dragging');
      if (ev.pointerType === 'touch' && navigator.vibrate) navigator.vibrate(40);
    }

    ev.preventDefault();
    clone.style.left = `${ev.clientX - offX}px`;
    clone.style.top  = `${ev.clientY - offY}px`;

    clone.style.visibility = 'hidden';
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    clone.style.visibility = '';

    clearDropHighlights();

    // Over the space bar → switch spaces live so the item can be dropped there.
    const tabBtn = under?.closest?.('.tab[data-tab-id]');
    if (tabBtn) {
      tabBtn.classList.add('tab--drop');
      const tabId = tabBtn.dataset.tabId;
      if (tabId !== state.activeTabId && tabId !== lastTab) {
        lastTab = tabId;
        setActiveTab(tabId);
        // The board was rebuilt, so the faded-out originals have to be re-marked
        payload.keys.forEach(k => elementForKey(k)?.classList.add(cfg.dragCls, 'drag-source'));
      }
      return;
    }
    lastTab = null;
    highlightDropTarget(payload, under);
  };

  const up = ev => {
    if (ev.pointerId !== pid) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (started) {
      clone.style.visibility = 'hidden';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      clone.style.visibility = '';
      clone.remove();
      document.querySelectorAll('.drag-source').forEach(el =>
        el.classList.remove('drag-source', 'hw-dragging', 'folder-dragging', 'class-dragging'));
      clearDropHighlights();
      document.body.classList.remove('is-dragging');
      commitDrop(payload, under);
    }
  };

  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

function highlightDropTarget(payload, under) {
  if (payload.kind === 'class') {
    const overRow = under?.closest?.('.class-row');
    if (overRow && !payload.keys.includes(selKey('cls', overRow.dataset.classId))) {
      overRow.classList.add('class-drag-over');
    }
    return;
  }
  const overItem = under?.closest?.('.hw-item');
  if (overItem && !payload.keys.includes(selKey('hw', overItem.dataset.hwId))) {
    overItem.classList.add('hw-drag-over');
    return;
  }
  const overFolder = under?.closest?.('.folder');
  if (overFolder && !payload.keys.includes(selKey('fd', overFolder.dataset.folderId))) {
    // A folder can't go inside a folder — it lands beside it instead
    overFolder.classList.add(payload.keys.some(k => k.startsWith('fd:')) ? 'hw-drag-over' : 'folder-drop-target');
    return;
  }
  const overRow = under?.closest?.('.class-row');
  if (overRow) overRow.classList.add('group-drop-target');
}

function commitDrop(payload, under) {
  if (payload.kind === 'class') {
    const overRow  = under?.closest?.('.class-row');
    const beforeId = overRow && !payload.keys.includes(selKey('cls', overRow.dataset.classId))
      ? overRow.dataset.classId : null;
    // The space may have switched during the drag — that's the destination.
    return moveClasses(payload.keys.map(k => splitKey(k)[1]), state.activeTabId, beforeId);
  }

  const hasFolder = payload.keys.some(k => k.startsWith('fd:'));
  const overItem  = under?.closest?.('.hw-item');
  if (overItem && !payload.keys.includes(selKey('hw', overItem.dataset.hwId))) {
    const target = state.homework.find(h => h.id === overItem.dataset.hwId);
    if (!target) return;
    // Dropping a folder onto an assignment that lives inside another folder puts
    // it on the group's top level, just ahead of that folder.
    if (target.folderId && hasFolder) return moveItems(payload.keys, target.classId, null, selKey('fd', target.folderId));
    return moveItems(payload.keys, target.classId, target.folderId || null, selKey('hw', target.id));
  }

  const overFolder = under?.closest?.('.folder');
  if (overFolder && !payload.keys.includes(selKey('fd', overFolder.dataset.folderId))) {
    const folder = state.folders.find(f => f.id === overFolder.dataset.folderId);
    if (!folder) return;
    if (hasFolder) return moveItems(payload.keys, folder.classId, null, selKey('fd', folder.id));
    return moveItems(payload.keys, folder.classId, folder.id, null); // append into the folder
  }

  const overRow = under?.closest?.('.class-row');
  if (overRow) return moveItems(payload.keys, overRow.dataset.classId, null, null); // append to group
  // dropped on empty space / a space with no group → leave everything where it was
}

/* ---------------------------------------------------------------------------
   PLACEMENT SNAPSHOTS — a drag changes both the source and the target list, so
   undoing a move means restoring the group/folder/space membership *and* the
   ordering of every sibling that shifted. These capture and re-apply that whole
   picture.
   --------------------------------------------------------------------------- */

/* Snapshot every folder and assignment living in `classIds`, plus any explicitly
   named assignments, so a completed one being moved is still covered. Completed
   assignments in an affected group only matter when they sit in a folder, since
   a folder move rewrites their classId too. */
function snapshotBoard(classIds, extraHwIds = []) {
  const groups = new Set([...classIds].filter(Boolean));
  const extra  = new Set(extraHwIds);
  return {
    hw: state.homework
      .filter(h => (groups.has(h.classId) ? (!h.completed || !!h.folderId) : extra.has(h.id)))
      .map(h => ({ id: h.id, classId: h.classId, folderId: h.folderId || null, order: h.order ?? 9999, completed: !!h.completed })),
    folders: state.folders
      .filter(f => groups.has(f.classId))
      .map(f => ({ id: f.id, classId: f.classId, order: f.order ?? 9999 }))
  };
}

/* Stable signature of a snapshot: what each container holds, in visual order,
   plus where every item lives. Raw `order` numbers can't be compared directly —
   a snapshot taken after a move has been renumbered 0..n-1 and one taken before
   it hasn't — so positions only ever enter as list order. Used to skip pushing
   history for a drag that changed nothing. */
function boardSig(snap) {
  const containers = {};
  const push = (k, entry) => (containers[k] ||= []).push(entry);
  snap.folders.forEach(f => push(`C:${f.classId}`, { id: `fd:${f.id}`, order: f.order }));
  snap.hw.filter(h => !h.completed).forEach(h =>
    push(h.folderId ? `F:${h.folderId}` : `C:${h.classId}`, { id: `hw:${h.id}`, order: h.order }));

  const orderPart = Object.keys(containers).sort().map(k =>
    `${k}[${containers[k].sort((a, b) => a.order - b.order).map(e => e.id).join(',')}]`).join('|');
  const memberPart = [
    ...snap.hw.map(h => `hw:${h.id}>${h.classId}/${h.folderId || '-'}`),
    ...snap.folders.map(f => `fd:${f.id}>${f.classId}`)
  ].sort().join(',');
  return `${orderPart}#${memberPart}`;
}

/* Renumber every container inside `classIds` — each group's top level and each
   of its folders — so orders run 0..n-1, and return the writes that implies. */
function renumberClasses(classIds, prevHwOrders, prevFolderOrders) {
  const hw = [], folders = [];
  for (const classId of classIds) {
    groupChildren(classId).forEach((child, i) => {
      child.ref.order = i;
      (child.type === 'fd' ? folders : hw).push({
        id: child.id, order: i,
        prev: (child.type === 'fd' ? prevFolderOrders : prevHwOrders).get(child.id)
      });
    });
    state.folders.filter(f => f.classId === classId).forEach(folder => {
      folderChildren(folder.id).forEach((child, i) => {
        child.ref.order = i;
        hw.push({ id: child.id, order: i, prev: prevHwOrders.get(child.id) });
      });
    });
  }
  return { hw, folders };
}

/* Write the renumbering out, folding in the parent changes (`classId`,
   `folderId`) that made it necessary. A parent change is critical: it must not
   be silently dropped just because that doc's order happened not to move. */
async function persistPlacement(classIds, prevHwOrders, prevFolderOrders, hwData = new Map(), folderData = new Map()) {
  const entries = renumberClasses(classIds, prevHwOrders, prevFolderOrders);
  const attach = (list, dataMap) => {
    const seen = new Set(list.map(e => e.id));
    list.forEach(e => { if (dataMap.has(e.id)) { e.data = dataMap.get(e.id); e.critical = true; } });
    dataMap.forEach((data, id) => { if (!seen.has(id)) list.push({ id, data, critical: true }); });
  };
  attach(entries.hw, hwData);
  attach(entries.folders, folderData);
  if (entries.folders.length) await writeOrders('folders',  entries.folders);
  if (entries.hw.length)      await writeOrders('homework', entries.hw);
}

/* Put local state back the way a snapshot describes it, without writing. Used to
   roll the UI back when a move fails: a move that's visible but unsaved is worse
   than no move, because the next drag would persist the phantom layout as real. */
function applyBoardLocally(snap) {
  snap.folders.forEach(s => {
    const f = state.folders.find(x => x.id === s.id);
    if (f) { f.classId = s.classId; f.order = s.order; }
  });
  snap.hw.forEach(s => {
    const h = state.homework.find(x => x.id === s.id);
    if (h) { h.classId = s.classId; h.folderId = s.folderId; h.order = s.order; }
  });
}

/* Re-apply a snapshot to state *and* the server, then re-render. */
async function restoreBoard(snap, focusKey) {
  // Every group the restore touches — where each item sits now, and where it goes
  const affected = new Set();
  snap.folders.forEach(s => {
    const f = state.folders.find(x => x.id === s.id);
    if (f) { affected.add(s.classId); affected.add(f.classId); }
  });
  snap.hw.forEach(s => {
    const h = state.homework.find(x => x.id === s.id);
    if (h) { affected.add(s.classId); affected.add(h.classId); }
  });

  // Orders as they currently stand, which is what's persisted. Captured before
  // any mutation so the write can skip docs landing back on the index they
  // already have — a restore shouldn't cost a write per sibling.
  const prevHwOrders = new Map(), prevFolderOrders = new Map();
  state.homework.forEach(h => { if (affected.has(h.classId)) prevHwOrders.set(h.id, h.order); });
  state.folders.forEach(f  => { if (affected.has(f.classId)) prevFolderOrders.set(f.id, f.order); });

  const hwData = new Map(), folderData = new Map();
  snap.folders.forEach(s => {
    const f = state.folders.find(x => x.id === s.id);
    if (!f) return;
    if (f.classId !== s.classId) folderData.set(f.id, { classId: s.classId });
    f.classId = s.classId; f.order = s.order;
  });
  snap.hw.forEach(s => {
    const h = state.homework.find(x => x.id === s.id);
    if (!h) return;
    const data = {};
    if (h.classId !== s.classId) data.classId = s.classId;
    if ((h.folderId || null) !== s.folderId) data.folderId = s.folderId;
    if (Object.keys(data).length) hwData.set(h.id, data);
    h.classId = s.classId; h.folderId = s.folderId; h.order = s.order;
  });

  await persistPlacement([...affected], prevHwOrders, prevFolderOrders, hwData, folderData);
  focusItem(focusKey || (snap.hw[0] && selKey('hw', snap.hw[0].id)));
  renderSchedule();
  renderSummary();
}

/* Bring the space holding an item into view, so a move or an undo is visible. */
function focusItem(key) {
  if (!key) return;
  const [type, id] = splitKey(key);
  const classId = type === 'hw'  ? state.homework.find(h => h.id === id)?.classId
                : type === 'fd'  ? state.folders.find(f => f.id === id)?.classId
                :                  id;
  const home = state.classes.find(c => c.id === classId);
  if (home && home.tabId !== state.activeTabId) { state.activeTabId = home.tabId; renderTabBar(); }
}

/* How to name a pile of moved things in a toast. */
function describeItems(moved) {
  if (moved.length === 1) {
    const it = moved[0];
    return `"${it.type === 'fd' ? it.ref.name : it.ref.description}"`;
  }
  return `${moved.length} items`;
}

/* -----------------------------------------------------------------------------
   MOVE — assignments and folders

   `keys`      selection keys, in the order they should land
   `classId`   destination group
   `folderId`  destination folder inside it, or null for the group's top level
   `beforeKey` the item to land in front of, or null to append
   ----------------------------------------------------------------------------- */
async function moveItems(keys, targetClassId, targetFolderId, beforeKey) {
  const targetCls = state.classes.find(c => c.id === targetClassId);
  if (!targetCls) return;
  // A folder only ever holds assignments from its own group, so the destination
  // folder and group have to agree.
  if (targetFolderId && !state.folders.some(f => f.id === targetFolderId && f.classId === targetClassId)) return;

  // An assignment inside a folder that is itself moving travels with the folder,
  // and folders don't nest, so a folder aimed into a folder is simply dropped.
  const movingFolders = new Set(keys.filter(k => k.startsWith('fd:')).map(k => k.slice(3)));
  const moved = [];
  for (const key of keys) {
    if (key === beforeKey) continue;
    const [type, id] = splitKey(key);
    if (type === 'fd') {
      const folder = state.folders.find(f => f.id === id);
      if (folder && !targetFolderId) moved.push({ type: 'fd', id, ref: folder });
    } else if (type === 'hw') {
      const hw = state.homework.find(h => h.id === id);
      if (hw && !(hw.folderId && movingFolders.has(hw.folderId))) moved.push({ type: 'hw', id, ref: hw });
    }
  }
  if (!moved.length) return;

  const affected = new Set([targetClassId, ...moved.map(m => m.ref.classId)]);
  const extraHwIds = moved.filter(m => m.type === 'hw').map(m => m.id);
  const before = snapshotBoard(affected, extraHwIds);
  const prevActiveTab = state.activeTabId;

  const prevHwOrders = new Map(), prevFolderOrders = new Map();
  state.homework.forEach(h => { if (affected.has(h.classId)) prevHwOrders.set(h.id, h.order); });
  state.folders.forEach(f  => { if (affected.has(f.classId)) prevFolderOrders.set(f.id, f.order); });

  // Where they land: the destination list minus whatever is being moved, with
  // the moved pile spliced in at the drop point.
  const movedKeys = new Set(moved.map(m => selKey(m.type, m.id)));
  const list = containerItems(targetClassId, targetFolderId)
    .filter(c => !movedKeys.has(selKey(c.type, c.id)));
  const at = beforeKey ? list.findIndex(c => selKey(c.type, c.id) === beforeKey) : -1;
  list.splice(at === -1 ? list.length : at, 0, ...moved);

  const hwData = new Map(), folderData = new Map();
  for (const m of moved) {
    if (m.type === 'fd') {
      if (m.ref.classId === targetClassId) continue;
      folderData.set(m.id, { classId: targetClassId });
      // Everything inside comes along, completed assignments included — they are
      // hidden from the board but still carry the group they belong to.
      state.homework.filter(h => h.folderId === m.id).forEach(h => {
        hwData.set(h.id, { classId: targetClassId });
        h.classId = targetClassId;
      });
      m.ref.classId = targetClassId;
    } else {
      const data = {};
      if (m.ref.classId !== targetClassId) data.classId = targetClassId;
      if ((m.ref.folderId || null) !== (targetFolderId || null)) data.folderId = targetFolderId || null;
      if (Object.keys(data).length) hwData.set(m.id, data);
      m.ref.classId  = targetClassId;
      m.ref.folderId = targetFolderId || null;
    }
  }
  list.forEach((c, i) => { c.ref.order = i; });

  let tabChanged = false;
  if (targetCls.tabId !== state.activeTabId) { state.activeTabId = targetCls.tabId; tabChanged = true; renderTabBar(); }
  renderSchedule();
  renderSummary();

  try {
    await persistPlacement([...affected], prevHwOrders, prevFolderOrders, hwData, folderData);

    const after = snapshotBoard(affected, extraHwIds);
    if (boardSig(before) !== boardSig(after)) {
      const label = describeItems(moved);
      const focus = keys[0];
      history.push({
        async undo() { await restoreBoard(before, focus); toast(`Moved ${label} back`, 'info'); },
        async redo() { await restoreBoard(after,  focus); toast(`Moved ${label}`, 'success'); }
      });
    }
  } catch (err) {
    applyBoardLocally(before);
    if (tabChanged) { state.activeTabId = prevActiveTab; renderTabBar(); }
    renderSchedule();
    renderSummary();
    toast(`Move failed: ${err.message}`, 'error');
  }
}

/* -----------------------------------------------------------------------------
   MOVE — groups

   A group carries its folders and assignments with it implicitly: both point at
   the group, not the space, so only `tabId` and `order` ever change.
   ----------------------------------------------------------------------------- */
function classSig(snap) {
  const byTab = {};
  snap.forEach(s => (byTab[s.tabId] ||= []).push(s));
  return Object.keys(byTab).sort().map(t =>
    `${t}[${byTab[t].slice().sort((a, b) => a.order - b.order).map(s => s.id).join(',')}]`).join('|');
}

function snapshotClasses(tabIds) {
  const tabs = new Set([...tabIds].filter(Boolean));
  return state.classes.filter(c => tabs.has(c.tabId))
    .map(c => ({ id: c.id, tabId: c.tabId, order: c.order ?? 9999 }));
}

/* Renumber each affected space 0..n-1 and write that out, folding in the space
   changes that made it necessary. */
async function persistClassPlacement(tabIds, prevOrders, tabData) {
  const entries = [];
  for (const tabId of tabIds) {
    state.classes.filter(c => c.tabId === tabId)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
      .forEach((c, i) => { c.order = i; entries.push({ id: c.id, order: i, prev: prevOrders.get(c.id) }); });
  }
  const seen = new Set(entries.map(e => e.id));
  entries.forEach(e => { if (tabData.has(e.id)) { e.data = tabData.get(e.id); e.critical = true; } });
  tabData.forEach((data, id) => { if (!seen.has(id)) entries.push({ id, data, critical: true }); });
  if (entries.length) await writeOrders('classes', entries);
  resortClasses();
}

async function restoreClasses(snap, focusId) {
  const affected = new Set();
  snap.forEach(s => {
    const c = state.classes.find(x => x.id === s.id);
    if (c) { affected.add(s.tabId); affected.add(c.tabId); }
  });
  const prevOrders = new Map();
  state.classes.forEach(c => { if (affected.has(c.tabId)) prevOrders.set(c.id, c.order); });

  const tabData = new Map();
  snap.forEach(s => {
    const c = state.classes.find(x => x.id === s.id);
    if (!c) return;
    if (c.tabId !== s.tabId) tabData.set(c.id, { tabId: s.tabId });
    c.tabId = s.tabId; c.order = s.order;
  });

  await persistClassPlacement([...affected], prevOrders, tabData);
  const focus = snap.find(s => s.id === focusId) || snap[0];
  if (focus && focus.tabId !== state.activeTabId) { state.activeTabId = focus.tabId; renderTabBar(); }
  renderSchedule();
  renderSettingsClassList();
}

async function moveClasses(ids, targetTabId, beforeId) {
  const moving = ids.map(id => state.classes.find(c => c.id === id)).filter(Boolean);
  if (!moving.length || !targetTabId || !state.tabs.some(t => t.id === targetTabId)) return;

  const movingIds = new Set(moving.map(c => c.id));
  const affected  = new Set([targetTabId, ...moving.map(c => c.tabId)]);
  const before    = snapshotClasses(affected);
  const prevOrders = new Map();
  state.classes.forEach(c => { if (affected.has(c.tabId)) prevOrders.set(c.id, c.order); });

  const tabData = new Map();
  moving.forEach(c => {
    if (c.tabId !== targetTabId) tabData.set(c.id, { tabId: targetTabId });
    c.tabId = targetTabId;
  });

  const group = state.classes
    .filter(c => c.tabId === targetTabId && !movingIds.has(c.id))
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const at = beforeId ? group.findIndex(c => c.id === beforeId) : -1;
  group.splice(at === -1 ? group.length : at, 0, ...moving);
  group.forEach((c, i) => { c.order = i; });

  resortClasses();
  renderSchedule();

  try {
    await persistClassPlacement([...affected], prevOrders, tabData);
    const after = snapshotClasses(affected);
    if (classSig(before) !== classSig(after)) {
      const label = moving.length === 1 ? `"${moving[0].name}"` : `${moving.length} groups`;
      const focus = moving[0].id;
      history.push({
        async undo() { await restoreClasses(before, focus); toast(`Moved ${label} back`, 'info'); },
        async redo() { await restoreClasses(after,  focus); toast(`Moved ${label}`, 'success'); }
      });
    }
    renderSettingsClassList();
  } catch (err) {
    before.forEach(s => {
      const c = state.classes.find(x => x.id === s.id);
      if (c) { c.tabId = s.tabId; c.order = s.order; }
    });
    resortClasses();
    renderSchedule();
    toast(`Move failed: ${err.message}`, 'error');
  }
}

/* =============================================================================
   CONTEXT MENU — custom right-click (desktop) / long-press (touch) menu for
   assignments and groups: Edit, Move to…, Delete.
   ============================================================================= */
let _ctx = null; // { type, id, key, keys, x, y }

function closeContextMenu() {
  document.getElementById('context-menu')?.remove();
  _ctx = null;
  document.removeEventListener('pointerdown', onCtxOutside, true);
  document.removeEventListener('keydown', onCtxKey, true);
  window.removeEventListener('scroll', closeContextMenu, true);
  window.removeEventListener('resize', closeContextMenu, true);
}
function onCtxOutside(e) { if (!e.target.closest('#context-menu')) closeContextMenu(); }
function onCtxKey(e)     { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); } }

function openContextMenu(x, y, type, id) {
  closeContextMenu();
  const key  = selKey(type, id);
  const kind = type === 'class' ? 'class' : 'item';
  // Right-clicking inside the selection acts on all of it. Right-clicking
  // outside it acts on just that one thing but leaves the selection alone, so
  // the menu's own Select entry can build one up a tap at a time — the only way
  // to multi-select on a touch screen, where there is no Ctrl to hold.
  const inSel = sel.kind === kind && sel.ids.has(key);
  const keys  = inSel ? [key, ...selectionKeys(kind).filter(k => k !== key)] : [key];
  _ctx = { type, id, key, kind, keys, inSel, x, y };

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'context-menu';
  document.body.appendChild(menu);
  renderCtxRoot();
  setTimeout(() => {
    document.addEventListener('pointerdown', onCtxOutside, true);
    document.addEventListener('keydown', onCtxKey, true);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu, true);
  }, 0);
}

function positionCtxMenu() {
  const menu = document.getElementById('context-menu');
  if (!menu || !_ctx) return;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = `${Math.max(8, Math.min(_ctx.x, vw - w - 8))}px`;
  menu.style.top  = `${Math.max(8, Math.min(_ctx.y, vh - h - 8))}px`;
}

function ctxBtn(label, icon, onClick, opts = {}) {
  const b = document.createElement('button');
  b.className = `ctx-item${opts.danger ? ' ctx-item--danger' : ''}${opts.muted ? ' ctx-item--muted' : ''}${opts.indent ? ' ctx-item--indent' : ''}`;
  b.innerHTML = `<span class="ctx-icon">${icon || ''}</span><span class="ctx-label">${esc(label)}</span>${opts.arrow ? '<span class="ctx-arrow">›</span>' : ''}`;
  if (opts.hint) b.title = opts.hint;
  if (onClick) b.addEventListener('click', onClick);
  else b.disabled = true;
  return b;
}
function ctxDivider() { const d = document.createElement('div'); d.className = 'ctx-divider'; return d; }
function ctxHeading(text) {
  const h = document.createElement('div');
  h.className = 'ctx-heading';
  h.textContent = text;
  return h;
}

// Assignments actually affected by an action on `keys` — a selected folder brings
// its contents along, and an assignment already inside one isn't counted twice.
function itemsInKeys(keys) {
  const folderIds = new Set(keys.filter(k => k.startsWith('fd:')).map(k => k.slice(3)));
  const hw = new Map();
  keys.filter(k => k.startsWith('hw:')).forEach(k => {
    const h = state.homework.find(x => x.id === k.slice(3));
    if (h && !folderIds.has(h.folderId)) hw.set(h.id, h);
  });
  state.homework.filter(h => folderIds.has(h.folderId)).forEach(h => hw.set(h.id, h));
  return {
    folders: [...folderIds].map(id => state.folders.find(f => f.id === id)).filter(Boolean),
    hw: [...hw.values()]
  };
}

function renderCtxRoot() {
  const menu = document.getElementById('context-menu');
  if (!menu || !_ctx) return;
  const { type, id, keys, inSel } = _ctx;
  const multi = keys.length > 1;
  menu.innerHTML = '';

  if (multi) {
    const noun = type === 'class' ? 'group' : 'item';
    menu.appendChild(ctxHeading(`${keys.length} ${noun}s selected`));
  } else {
    menu.appendChild(ctxBtn(inSel ? 'Deselect' : sel.ids.size ? 'Add to selection' : 'Select', '☑',
      () => { closeContextMenu(); handleSelectClick(_ctx.key, true, false); }));
    menu.appendChild(ctxDivider());
  }

  if (type === 'class') {
    if (!multi) {
      menu.appendChild(ctxBtn('Add assignment', '＋', () => { closeContextMenu(); openHwModal(id); }));
      menu.appendChild(ctxBtn('New folder', '📂',     () => { closeContextMenu(); promptNewFolder(id, []); }));
      menu.appendChild(ctxBtn('Edit', '✎',            () => { closeContextMenu(); startEditClass(state.classes.find(c => c.id === id)); }));
    }
    menu.appendChild(ctxBtn('Move to space…', '↗', () => renderCtxMoveClass(), { arrow: true }));
    menu.appendChild(ctxDivider());
    menu.appendChild(ctxBtn(multi ? `Delete ${keys.length} groups` : 'Delete', '🗑',
      () => { closeContextMenu(); deleteClasses(keys.map(k => splitKey(k)[1])); }, { danger: true }));
    positionCtxMenu();
    return;
  }

  if (type === 'folder' && !multi) {
    const folder = state.folders.find(f => f.id === id);
    if (!folder) { closeContextMenu(); return; }
    menu.appendChild(ctxBtn('Add assignment', '＋', () => { closeContextMenu(); openHwModal(folder.classId, folder.id); }));
    menu.appendChild(ctxBtn('Rename folder', '✎',   () => { closeContextMenu(); promptRenameFolder(folder.id); }));
    menu.appendChild(ctxBtn('Move to…', '↗',        () => renderCtxMoveItems(), { arrow: true }));
    menu.appendChild(ctxDivider());
    menu.appendChild(ctxBtn('Disband folder', '📤', () => { closeContextMenu(); disbandFolder(folder.id); },
      { hint: 'Remove the label and leave the assignments where they are' }));
    menu.appendChild(ctxBtn('Delete folder', '🗑',   () => { closeContextMenu(); deleteItems([selKey('fd', folder.id)]); },
      { danger: true, hint: 'Delete the folder and everything inside it' }));
    positionCtxMenu();
    return;
  }

  // One assignment, or a mixed pile of assignments and folders
  const hw = type === 'hw' ? state.homework.find(h => h.id === id) : null;
  if (!multi && hw) {
    menu.appendChild(ctxBtn('Edit', '✎', () => { closeContextMenu(); openHwEditModal(id); }));
  }
  menu.appendChild(ctxBtn('Move to…', '↗', () => renderCtxMoveItems(), { arrow: true }));
  if (!keys.some(k => k.startsWith('fd:'))) {
    menu.appendChild(ctxBtn(multi ? `New folder from ${keys.length} assignments` : 'New folder from this', '📂',
      () => { closeContextMenu(); promptNewFolder(null, keys); }));
  }
  if (keys.some(k => k.startsWith('hw:') && state.homework.find(h => h.id === k.slice(3))?.folderId)) {
    menu.appendChild(ctxBtn('Move out of folder', '📤', () => {
      closeContextMenu();
      const first = state.homework.find(h => h.id === splitKey(keys[0])[1]);
      if (first) moveItems(keys, first.classId, null, null);
    }));
  }
  menu.appendChild(ctxDivider());
  const { folders: fCount, hw: hwCount } = itemsInKeys(keys);
  const delLabel = multi
    ? `Delete ${keys.length} items`
    : (fCount.length ? 'Delete folder' : 'Delete');
  menu.appendChild(ctxBtn(delLabel, '🗑', () => { closeContextMenu(); deleteItems(keys); },
    { danger: true, hint: hwCount.length ? `${hwCount.length} assignment${hwCount.length === 1 ? '' : 's'}` : '' }));
  positionCtxMenu();
}

/* Every place an assignment or folder can land: each group, and each folder
   inside it. Folders can't nest, so they only ever offer groups. */
function renderCtxMoveItems() {
  const menu = document.getElementById('context-menu');
  if (!menu || !_ctx) return;
  const keys      = _ctx.keys;
  const hasFolder = keys.some(k => k.startsWith('fd:'));
  menu.innerHTML = '';
  menu.appendChild(ctxBtn('Back', '‹', () => renderCtxRoot()));
  menu.appendChild(ctxDivider());

  const ordered = state.tabs.flatMap(tab =>
    state.classes.filter(c => c.tabId === tab.id).map(c => ({ tab, cls: c })));
  if (!ordered.length) menu.appendChild(ctxBtn('No groups', '', null, { muted: true }));

  ordered.forEach(({ tab, cls }) => {
    const label = tab.id !== state.activeTabId ? `${tab.name} · ${cls.name}` : cls.name;
    menu.appendChild(ctxBtn(label, '📁', () => { closeContextMenu(); moveItems(keys, cls.id, null, null); }));
    if (hasFolder) return;
    state.folders.filter(f => f.classId === cls.id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach(f => menu.appendChild(ctxBtn(f.name, '📂',
        () => { closeContextMenu(); moveItems(keys, cls.id, f.id, null); }, { indent: true })));
  });
  positionCtxMenu();
}

function renderCtxMoveClass() {
  const menu = document.getElementById('context-menu');
  if (!menu || !_ctx) return;
  const ids = _ctx.keys.map(k => splitKey(k)[1]);
  const from = new Set(ids.map(cid => state.classes.find(c => c.id === cid)?.tabId));
  menu.innerHTML = '';
  menu.appendChild(ctxBtn('Back', '‹', () => renderCtxRoot()));
  menu.appendChild(ctxDivider());
  const targets = state.tabs.filter(t => !(from.size === 1 && from.has(t.id)));
  if (!targets.length) menu.appendChild(ctxBtn('No other spaces', '', null, { muted: true }));
  targets.forEach(t => menu.appendChild(ctxBtn(t.name, '🗂',
    () => { closeContextMenu(); moveClasses(ids, t.id, null); })));
  positionCtxMenu();
}

/* =============================================================================
   ATTACHMENTS
   ============================================================================= */
function isImageType(type) { return type && type.startsWith('image/'); }

function fileIcon(type) {
  if (!type) return '📎';
  if (type.includes('pdf'))          return '📄';
  if (type.includes('word') || type.includes('doc')) return '📝';
  if (type.includes('sheet') || type.includes('excel') || type.includes('xls')) return '📊';
  if (type.includes('presentation') || type.includes('ppt')) return '📑';
  if (type.includes('video'))        return '🎬';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

function renderFormAttachments() {
  const container = document.getElementById('form-attachments');
  if (!container) return;
  container.classList.toggle('hidden', formAttachments.length === 0);
  container.innerHTML = '';
  formAttachments.forEach(att => {
    const item = document.createElement('div');
    item.className = 'form-attach-item';
    if (isImageType(att.type)) {
      if (att.uploading) {
        item.innerHTML = `<div class="form-attach-thumb form-attach-thumb--loading"><span class="spinner-sm"></span></div>`;
      } else {
        item.innerHTML = `<img class="form-attach-thumb" src="${esc(att.localUrl || att.url)}" alt="${esc(att.name)}">`;
      }
    } else {
      item.innerHTML = `<div class="form-attach-file">${fileIcon(att.type)}<span class="form-attach-file-name">${esc(att.name)}</span>${att.uploading ? '<span class="spinner-sm"></span>' : ''}</div>`;
    }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'form-attach-remove'; rm.innerHTML = '&times;'; rm.title = 'Remove';
    rm.addEventListener('click', () => removeFormAttachment(att.id));
    item.appendChild(rm);
    container.appendChild(item);
  });
}

async function removeFormAttachment(id) {
  const idx = formAttachments.findIndex(a => a.id === id);
  if (idx === -1) return;
  const att = formAttachments.splice(idx, 1)[0];
  renderFormAttachments();
  if (att.localUrl) URL.revokeObjectURL(att.localUrl);
  if (att.storagePath && !att.uploading) {
    try { await storage.ref(att.storagePath).delete(); } catch (_) {}
  }
}

function handleAttachFiles(files) {
  if (!currentUser || !files || !files.length) return;
  Array.from(files).forEach(file => {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const localUrl = isImageType(file.type) ? URL.createObjectURL(file) : null;
    const att = { id, name: file.name, type: file.type, localUrl, url: null, storagePath: null, uploading: true, error: false, _promise: null };
    formAttachments.push(att);
    renderFormAttachments();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `users/${currentUser.uid}/hw-attachments/${id}-${safeName}`;
    att._promise = storage.ref(storagePath).put(file)
      .then(snap => snap.ref.getDownloadURL())
      .then(url => {
          if (formAttachments.includes(att)) { att.url = url; att.storagePath = storagePath; att.uploading = false; }
        renderFormAttachments();
      })
      .catch(() => {
        if (formAttachments.includes(att)) { att.uploading = false; att.error = true; }
        renderFormAttachments();
        toast(`Failed to upload "${file.name}"`, 'error');
      });
  });
}

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

function buildHwItem(hw, draggable = false) {
  const item = document.createElement('div');
  const hasMultiLineNotes = hw.notes && hw.notes.includes('\n');
  const hasAttachments = !!(hw.attachments && hw.attachments.length);
  const isExpandable = !!(hasMultiLineNotes || hw.description.length > 50 || hasAttachments);
  const startExpanded = isExpandable && new Set(prefs.get('expandedHw', [])).has(hw.id);
  item.className = `hw-item${isExpandable ? ' hw-item--collapsible' : ''}${startExpanded ? ' hw-item--expanded' : ''}`;
  item.dataset.hwId = hw.id;

  const dl     = parseDeadline(hw.deadline, hw.deadlineTime);
  const dlHtml = dl
    ? `<span class="deadline-badge ${dl.cssClass}">${esc(dl.label)}</span>`
    : '';
  const notesHtml = hw.notes
    ? `<span class="hw-notes${hasMultiLineNotes ? '' : ' hw-notes--always'}">${esc(hw.notes)}</span>`
    : '';
  const attachmentsHtml = hasAttachments
    ? `<div class="hw-attachments">${hw.attachments.map(a =>
        isImageType(a.type)
          ? `<img class="hw-attach-img" src="${esc(a.url)}" alt="${esc(a.name)}" data-lightbox="${esc(a.url)}" title="${esc(a.name)}">`
          : `<a class="hw-attach-file" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}">${fileIcon(a.type)}<span>${esc(a.name)}</span></a>`
      ).join('')}</div>`
    : '';
  const hintHtml = isExpandable ? `<span class="hw-expand-hint" aria-hidden="true">${startExpanded ? '▴ less' : '▾ more'}</span>` : '';

  item.innerHTML = `
    <span class="hw-drag-handle" title="Drag to reorder">⠿</span>
    <label class="hw-check-label" title="Mark complete">
      <input type="checkbox" class="hw-check" data-hw-id="${hw.id}">
      <span class="custom-check"></span>
    </label>
    <div class="hw-body">
      <span class="hw-desc">${esc(hw.description)}</span>
      ${hintHtml}
      ${notesHtml}
      ${attachmentsHtml}
    </div>
    <div class="hw-right">
      <button class="btn-icon-sm hw-edit-btn"   data-hw-id="${hw.id}" aria-label="Edit">✎</button>
      <button class="btn-icon-sm hw-delete"      data-hw-id="${hw.id}" aria-label="Delete">&#x2715;</button>
      ${hasAttachments ? `<span class="hw-attach-badge" title="${hw.attachments.length} attachment${hw.attachments.length !== 1 ? 's' : ''}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>${hw.attachments.length > 1 ? `<span>${hw.attachments.length}</span>` : ''}</span>` : ''}
      ${dlHtml}
    </div>
  `;
  if (draggable) attachDrag(item, 'hw', hw.id);
  return item;
}

/* =============================================================================
   RENDER — SUMMARY PANEL (all pending, sorted by deadline)
   ============================================================================= */
function renderSummary() {
  const list       = document.getElementById('summary-list');
  const empty      = document.getElementById('summary-empty');
  const countBadge = document.getElementById('summary-count');

  const pending = state.homework
    .filter(h => !h.completed)
    .sort((a,b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      const ta = new Date(a.deadline + (a.deadlineTime ? `T${a.deadlineTime}` : 'T23:59'));
      const tb = new Date(b.deadline + (b.deadlineTime ? `T${b.deadlineTime}` : 'T23:59'));
      return ta - tb;
    });

  countBadge.textContent = pending.length;
  countBadge.classList.toggle('hidden', pending.length === 0);

  if (pending.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';

  function buildSummaryItem(hw, showBadge) {
    const cls = state.classes.find(c => c.id === hw.classId);
    if (!cls) return null;
    const tab  = state.tabs.find(t => t.id === cls.tabId);
    const dl   = parseDeadline(hw.deadline, hw.deadlineTime);
    const item = document.createElement('div');
    item.className = 'summary-item';
    item.style.setProperty('--color', cls.color || '#94a3b8');
    const metaParts = [cls.name];
    if (tab && tab.id !== 'classes') metaParts.push(tab.name);
    const badgeHtml = showBadge && dl
      ? `<span class="deadline-badge ${dl.cssClass}">${esc(dl.label)}</span>`
      : '';
    item.innerHTML = `
      <div class="summary-color-bar"></div>
      <div class="summary-body">
        <span class="summary-desc">${esc(hw.description)}</span>
        <span class="summary-meta">${esc(metaParts.join(' · '))}</span>
      </div>
      <div class="summary-aside">
        ${badgeHtml}
        <div class="summary-actions">
          <button class="summary-btn summary-btn--edit" data-hw-id="${hw.id}" title="Edit">&#9998; Edit</button>
          <button class="summary-btn summary-btn--done" data-hw-id="${hw.id}" title="Mark complete">&#10003; Done</button>
        </div>
      </div>
    `;
    return item;
  }

  const withDate = pending.filter(h => h.deadline);
  const noDate   = pending.filter(h => !h.deadline);

  withDate.forEach(hw => {
    const item = buildSummaryItem(hw, true);
    if (item) list.appendChild(item);
  });

  if (noDate.length > 0) {
    const collapsed = prefs.get('summaryNodateCollapsed', false);
    const section = document.createElement('div');
    section.className = `summary-nodate-section${collapsed ? ' summary-nodate-section--collapsed' : ''}`;
    section.innerHTML = `
      <button class="summary-nodate-toggle">
        <span class="summary-nodate-label">No Due Date</span>
        <span class="summary-nodate-ct">${noDate.length}</span>
        <span class="summary-nodate-chevron">${collapsed ? '▾' : '▴'}</span>
      </button>
      <div class="summary-nodate-items"></div>
    `;
    const itemsEl = section.querySelector('.summary-nodate-items');
    noDate.forEach(hw => {
      const item = buildSummaryItem(hw, false);
      if (item) itemsEl.appendChild(item);
    });
    list.appendChild(section);
  }
}

/* =============================================================================
   RENDER — SETTINGS TABS LIST
   ============================================================================= */
function renderSettingsTabsList() {
  const list = document.getElementById('settings-tabs-list');
  list.innerHTML = '';
  state.tabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'settings-tab-item';
    item.dataset.tabId = tab.id;
    item.draggable = true;
    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="settings-tab-name">${esc(tab.name)}</span>
      <div class="settings-tab-actions">
        <button class="btn btn-sm btn-secondary edit-tab-btn" data-tab-id="${tab.id}">Edit</button>
        <button class="btn btn-sm btn-danger delete-tab-btn" data-tab-id="${tab.id}">Delete</button>
      </div>
    `;

    item.addEventListener('dragstart', e => {
      _draggedTabId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.settings-tab-item').forEach(el => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (_draggedTabId === tab.id) return;
      list.querySelectorAll('.settings-tab-item').forEach(el => el.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', e => {
      if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over');
    });
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!_draggedTabId || _draggedTabId === tab.id) return;

      const tabs    = [...state.tabs];
      const fromIdx = tabs.findIndex(t => t.id === _draggedTabId);
      const toIdx   = tabs.findIndex(t => t.id === tab.id);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);

      const prevTabs   = state.tabs;
      const prevOrders = new Map(tabs.map(t => [t.id, t.order]));
      tabs.forEach((t, i) => { t.order = i; });
      state.tabs = tabs;
      try {
        await api.tabs.reorder(tabs.map(t => t.id), { prevOrders });
        renderSettingsTabsList();
        renderTabBar();
      } catch (err) {
        prevOrders.forEach((order, id) => {
          const t = tabs.find(x => x.id === id);
          if (t) t.order = order;
        });
        state.tabs = prevTabs;
        renderSettingsTabsList();
        renderTabBar();
        toast(`Reorder failed: ${err.message}`, 'error');
      }
    });

    list.appendChild(item);
  });
}

/* =============================================================================
   RENDER — SETTINGS CLASS LIST (with drag-to-reorder)
   ============================================================================= */
function tabItemLabel(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return 'Topic';
  return singularize(tab.name.trim());
}

function renderSettingsClassList() {
  const tabId   = document.getElementById('settings-tab-select').value || 'classes';
  const list    = document.getElementById('settings-classes-list');
  const classes = state.classes.filter(c => c.tabId === tabId);
  const label   = tabItemLabel(tabId);
  const tab     = state.tabs.find(t => t.id === tabId);
  const plural  = tab ? tab.name : label + 's';

  document.getElementById('add-group-btn').textContent = '+ Add';

  if (classes.length === 0) {
    list.innerHTML = `<p class="settings-empty">No ${plural.toLowerCase()} in this space yet</p>`;
    return;
  }
  list.innerHTML = '';

  classes.forEach(cls => {
    const item = document.createElement('div');
    item.className = 'settings-class-item';
    item.dataset.classId = cls.id;
    item.draggable = true;

    const details = [cls.teacher, cls.room, cls.period].filter(Boolean).join(' · ');
    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="settings-class-dot" style="background:${esc(cls.color||'#3b82f6')}"></div>
      <div class="settings-class-info">
        <span class="settings-class-name">${esc(cls.name)}</span>
        ${details ? `<span class="settings-class-details">${esc(details)}</span>` : ''}
      </div>
      <div class="settings-class-actions">
        <button class="btn btn-sm btn-secondary edit-class-btn"  data-class-id="${cls.id}">Edit</button>
        <button class="btn btn-sm btn-danger   delete-class-btn" data-class-id="${cls.id}">Delete</button>
      </div>
    `;

    item.addEventListener('dragstart', e => {
      _draggedClassId = cls.id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.settings-class-item').forEach(el => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (_draggedClassId === cls.id) return;
      list.querySelectorAll('.settings-class-item').forEach(el => el.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', e => {
      if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over');
    });
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!_draggedClassId || _draggedClassId === cls.id) return;

      const tabClasses = [...state.classes.filter(c => c.tabId === tabId)];
      const fromIdx    = tabClasses.findIndex(c => c.id === _draggedClassId);
      const toIdx      = tabClasses.findIndex(c => c.id === cls.id);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = tabClasses.splice(fromIdx, 1);
      tabClasses.splice(toIdx, 0, moved);

      const prevClasses = state.classes;
      const prevOrders  = new Map(tabClasses.map(c => [c.id, c.order]));
      tabClasses.forEach((c, i) => { c.order = i; });
      state.classes = [...state.classes.filter(c => c.tabId !== tabId), ...tabClasses];
      try {
        await api.classes.reorder(tabClasses.map(c => c.id), { prevOrders });
        renderSettingsClassList();
        renderSchedule();
      } catch (err) {
        prevOrders.forEach((order, id) => {
          const c = tabClasses.find(x => x.id === id);
          if (c) c.order = order;
        });
        state.classes = prevClasses;
        renderSettingsClassList();
        renderSchedule();
        toast(`Reorder failed: ${err.message}`, 'error');
      }
    });

    list.appendChild(item);
  });
}

/* =============================================================================
   COLOR SWATCHES
   ============================================================================= */
function initColorSwatches() {
  const container  = document.getElementById('color-swatches');
  const colorInput = document.getElementById('class-color');
  PRESET_COLORS.forEach(color => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch';
    sw.dataset.color = color;
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener('click', () => { selectSwatch(color); colorInput.value = color; });
    container.appendChild(sw);
  });
  colorInput.addEventListener('input', () => {
    container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  });
}

function selectSwatch(color) {
  document.getElementById('class-color').value = color;
  document.getElementById('color-swatches').querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

/* =============================================================================
   HOMEWORK MODAL
   ============================================================================= */
function openHwModal(preselectedClassId = null, preselectedFolderId = null) {
  if (state.classes.length === 0) {
    toast('Add some topics first in Settings.', 'warning');
    return;
  }
  document.getElementById('hw-form').reset();
  document.getElementById('hw-reminder').value = '';
  document.getElementById('hw-edit-id').value = '';
  document.getElementById('hw-folder-id').value = preselectedFolderId || '';
  document.getElementById('hw-modal-title').textContent = 'New Assignment';
  document.getElementById('hw-form-submit').textContent = 'Add to Schedule';
  document.getElementById('hw-reminder-group').classList.add('hidden');
  formAttachments = [];
  renderFormAttachments();

  // Build grouped <optgroup> select
  const select = document.getElementById('hw-class');
  let html = '';
  state.tabs.forEach(tab => {
    const tabClasses = state.classes.filter(c => c.tabId === tab.id);
    if (!tabClasses.length) return;
    html += `<optgroup label="${esc(tab.name)}">`;
    tabClasses.forEach(cls => { html += `<option value="${cls.id}">${esc(cls.name)}</option>`; });
    html += '</optgroup>';
  });
  select.innerHTML = html;

  if (preselectedClassId) select.value = preselectedClassId;

  document.getElementById('hw-modal').classList.add('modal--open');
  document.getElementById('hw-desc').focus();
}

function openHwEditModal(hwId) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;

  openHwModal(hw.classId); // sets up select, resets form, opens modal

  // Override with existing values
  document.getElementById('hw-edit-id').value             = hw.id;
  document.getElementById('hw-desc').value                = hw.description || '';
  document.getElementById('hw-notes').value               = hw.notes       || '';
  document.getElementById('hw-deadline').value = hw.deadline || '';
  // Restore time picker
  if (hw.deadlineTime) {
    const [hh, mm] = hw.deadlineTime.split(':').map(Number);
    const ampm   = hh >= 12 ? 'PM' : 'AM';
    const hour12 = hh % 12 || 12;
    document.getElementById('hw-hour').value   = hour12;
    document.getElementById('hw-minute').value = String(mm).padStart(2, '0');
    document.getElementById('hw-ampm').value   = ampm;
  } else {
    document.getElementById('hw-hour').value   = '';
    document.getElementById('hw-minute').value = '';
    document.getElementById('hw-ampm').value   = 'AM';
  }
  // Populate reminder dropdown and show group if deadline is set
  const reminderSel = document.getElementById('hw-reminder');
  reminderSel.value = hw.remindBefore != null ? String(hw.remindBefore) : '';
  document.getElementById('hw-reminder-group').classList.toggle('hidden', !hw.deadline);

  document.getElementById('hw-modal-title').textContent   = 'Edit Assignment';
  document.getElementById('hw-form-submit').textContent   = 'Save Changes';

  // Load existing attachments into form state
  formAttachments = (hw.attachments || []).map(a => ({
    ...a,
    id: `att-${Math.random().toString(36).slice(2)}`,
    localUrl: null, uploading: false, error: false
  }));
  renderFormAttachments();
}

function closeHwModal() {
  document.getElementById('hw-modal').classList.remove('modal--open');
}

/* =============================================================================
   SETTINGS MODAL
   ============================================================================= */
function openSettings(page = state.tabs.length === 0 ? 'tabs' : 'account') {
  populateSettingsTabSelect(state.activeTabId);
  resetClassForm();
  renderSettingsTabsList();
  renderSettingsClassList();
  renderAccountPage();
  renderPrefsPage();
  switchSettingsPage(page);
  document.getElementById('settings-modal').classList.add('modal--open');
  if (page === 'tabs') {
    requestAnimationFrame(() => document.getElementById('tab-name').focus());
  }
}
function closeSettings() { document.getElementById('settings-modal').classList.remove('modal--open'); }

function populateSettingsTabSelect(selectValue) {
  const sel = document.getElementById('settings-tab-select');
  sel.innerHTML = state.tabs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = selectValue || state.activeTabId;
}

function switchSettingsPage(page) {
  ['tabs', 'classes', 'account', 'preferences', 'help', 'templates'].forEach(p => {
    document.getElementById(`settings-page-${p}`).classList.toggle('hidden', page !== p);
  });
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('settings-nav--active', btn.dataset.page === page);
  });
  if (page === 'classes') updateSettingsLabels();
}

function renderAccountPage() {
  if (!currentUser) return;
  const avatar = document.getElementById('settings-avatar');
  const name   = document.getElementById('settings-user-name');
  const email  = document.getElementById('settings-user-email');
  if (currentUser.photoURL) { avatar.src = currentUser.photoURL; avatar.alt = currentUser.displayName || ''; }
  if (currentUser.displayName) name.textContent = currentUser.displayName;
  if (currentUser.email) email.textContent = currentUser.email;
}

function renderPrefsPage() {
  // Highlight active theme card
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('theme-card--active', card.dataset.theme === prefs.get('theme', 'light'));
  });
  // Highlight active accent
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.classList.toggle('accent-swatch--active', sw.dataset.accent === prefs.get('accent', '#3b82f6'));
  });
  // Sync toggles
  document.getElementById('pref-compact').checked       = prefs.get('compact', false);
  document.getElementById('pref-summary').checked       = prefs.get('showSummary', true);
  document.getElementById('pref-notifications').checked = prefs.get('notificationsEnabled', false);
  document.getElementById('pref-notify-before').value   = String(prefs.get('notifyBefore', 60));
  const notifOn = prefs.get('notificationsEnabled', false);
  document.getElementById('pref-notify-before-row').classList.toggle('hidden', !notifOn);
  // document.getElementById('pref-notify-test-row').classList.toggle('hidden', !notifOn);
}

function initAccentSwatches() {
  const container = document.getElementById('accent-swatches');
  ACCENT_OPTIONS.forEach(opt => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'accent-swatch';
    sw.dataset.accent = opt.value;
    sw.style.background = opt.value;
    sw.title = opt.label;
    sw.addEventListener('click', () => {
      prefs.set('accent', opt.value);
      applyPrefs();
      renderPrefsPage();
    });
    container.appendChild(sw);
  });
}

function updateSettingsLabels() {
  const tabId  = document.getElementById('settings-tab-select')?.value || 'classes';
  const tab    = state.tabs.find(t => t.id === tabId);
  const name   = tab ? tab.name : 'Classes';
  const editId = document.getElementById('edit-class-id').value;
  if (!editId) {
    const singular = singularize(name);
    document.getElementById('group-form-title').textContent  = `Add New Group`;
    document.getElementById('class-form-submit').textContent = `Add Group`;
  }
}

function openGroupForm() {
  document.getElementById('group-form-modal').classList.add('modal--open');
  document.getElementById('class-name').focus();
}

function closeGroupForm() {
  document.getElementById('group-form-modal').classList.remove('modal--open');
  resetClassForm();
}

function resetClassForm() {
  document.getElementById('class-form').reset();
  document.getElementById('edit-class-id').value = '';
  document.getElementById('cancel-edit-class').classList.add('hidden');
  const tabId = document.getElementById('settings-tab-select')?.value || 'classes';
  selectSwatch(getNextAvailableColor(tabId));
  updateSettingsLabels();
}

function startEditClass(cls) {
  if (!cls) return;
  // The form reads the space from #settings-tab-select on submit, so point it at
  // the group's own space first — otherwise editing a group from the context menu
  // silently moves it into whatever space Settings happened to be showing.
  const sel = document.getElementById('settings-tab-select');
  if (sel) {
    if (!sel.options.length) populateSettingsTabSelect(cls.tabId);
    sel.value = cls.tabId;
    if (sel.value !== cls.tabId) { populateSettingsTabSelect(cls.tabId); sel.value = cls.tabId; }
    renderSettingsClassList();
  }
  document.getElementById('edit-class-id').value           = cls.id;
  document.getElementById('class-name').value              = cls.name    || '';
  document.getElementById('class-teacher').value           = cls.teacher || '';
  document.getElementById('class-room').value              = cls.room    || '';
  document.getElementById('class-period').value            = cls.period  || '';
  document.getElementById('group-form-title').textContent  = 'Edit Group';
  document.getElementById('class-form-submit').textContent = 'Save Changes';
  document.getElementById('cancel-edit-class').classList.remove('hidden');
  selectSwatch(cls.color || PRESET_COLORS[4]);
  openGroupForm();
}

/* =============================================================================
   EVENT HANDLERS
   ============================================================================= */
async function handleAddHomework(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('hw-form-submit');
  submitBtn.disabled = true;
  const editId      = document.getElementById('hw-edit-id').value;
  const classId     = document.getElementById('hw-class').value;
  const description = document.getElementById('hw-desc').value.trim();
  const notes       = document.getElementById('hw-notes').value.trim();
  const hourVal  = document.getElementById('hw-hour').value;
  const minuteVal = document.getElementById('hw-minute').value;
  const ampmVal  = document.getElementById('hw-ampm').value;
  let   deadline = document.getElementById('hw-deadline').value;
  if (!classId || !description) return;

  const pendingUploads = formAttachments.filter(a => a.uploading && a._promise);
  if (pendingUploads.length) {
    toast('Finishing uploads…', 'info');
    await Promise.allSettled(pendingUploads.map(a => a._promise));
    if (formAttachments.some(a => a.error)) {
      toast('Some files failed to upload — remove them and try again.', 'error');
      submitBtn.disabled = false;
      return;
    }
  }

  // Fix Chrome: if year is missing/invalid, default to current year
  if (deadline) {
    const parts = deadline.split('-');
    if (parseInt(parts[0]) < 2000) parts[0] = new Date().getFullYear();
    deadline = parts.join('-');
  }

  // Only build deadlineTime if user entered an hour
  let deadlineTime = '';
  const hParsed = parseInt(hourVal);
  if (hourVal.trim() && !isNaN(hParsed) && hParsed >= 1 && hParsed <= 12) {
    let h = hParsed;
    const mParsed = parseInt(minuteVal);
    const m = (!isNaN(mParsed) && mParsed >= 0 && mParsed <= 59) ? mParsed : 0;
    if (ampmVal === 'PM' && h !== 12) h += 12;
    if (ampmVal === 'AM' && h === 12) h = 0;
    deadlineTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const folderId    = document.getElementById('hw-folder-id').value;
  const reminderVal = document.getElementById('hw-reminder').value;
  const remindBefore = deadline && reminderVal !== '' ? parseInt(reminderVal) : null;

  let deadlineMs = null;
  if (deadline) {
    /* A date with no time means "sometime that day", so it ends the day rather
       than starting it — the same 23:59 the sort comparators already assume.
       Reading it as midnight put the whole day in the past and made reminders
       land the evening before ("1 hour before" arrived at 11pm on the 6th for
       something due on the 7th). Nothing but the reminder sender reads
       deadlineMs, so this is the only place the two ever disagreed. */
    const timeStr = deadlineTime || '23:59';
    deadlineMs = new Date(`${deadline}T${timeStr}:00`).getTime();
  }

  const attachments = formAttachments
    .filter(a => a.url && !a.error)
    .map(({ name, type, url, storagePath }) => ({ name, type, url, storagePath }));
  const payload = {
    classId, description,
    ...(!editId && folderId && state.folders.some(f => f.id === folderId && f.classId === classId) && { folderId }),
    ...(notes             && { notes }),
    ...(attachments.length && { attachments }),
    ...(deadline          && { deadline }),
    ...(deadlineTime      && { deadlineTime }),
    ...(deadlineMs  != null && { deadlineMs }),
    // In edit mode always include remindBefore (even null) so server can clear legacy 0 values
    ...(editId ? { remindBefore } : remindBefore != null ? { remindBefore } : {})
  };

  try {
    if (editId) {
      // ---- EDIT MODE ----
      // Folders belong to one group, so moving an assignment out of its group
      // through this form has to drop it out of whatever folder it was in.
      const before = state.homework.find(h => h.id === editId);
      if (before && before.folderId && before.classId !== classId) payload.folderId = null;
      const updated = await api.homework.update(editId, payload);
      const i = state.homework.findIndex(h => h.id === editId);
      if (i !== -1) state.homework[i] = { ...state.homework[i], ...updated };
      renderSchedule();
      renderSummary();
      closeHwModal();
      toast(`Updated "${description}"`, 'success');
    } else {
      // ---- CREATE MODE ----
      const hw = await api.homework.create(payload);
      state.homework.push(hw);
      renderSchedule();
      renderSummary();
      closeHwModal();
      toast(`Added "${description}"`, 'success');
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleClassFormSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('class-form-submit');
  submitBtn.disabled = true;
  const id      = document.getElementById('edit-class-id').value;
  const tabId   = document.getElementById('settings-tab-select').value || state.activeTabId;
  const teacher = document.getElementById('class-teacher').value.trim();
  const room    = document.getElementById('class-room').value.trim();
  const period  = normalizePeriod(document.getElementById('class-period').value) || '';
  const data    = {
    tabId,
    name:  document.getElementById('class-name').value.trim(),
    color: document.getElementById('class-color').value,
  };
  if (!data.name) return;

  if (id) {
    data.teacher = teacher;
    data.room    = room;
    data.period  = period;
  } else {
    if (teacher) data.teacher = teacher;
    if (room)    data.room    = room;
    if (period)  data.period  = period;
  }

  try {
    if (id) {
      const updated = await api.classes.update(id, data);
      const i = state.classes.findIndex(c => c.id === id);
      if (i !== -1) state.classes[i] = updated;
      toast(`Updated "${data.name}"`, 'success');
    } else {
      const created = await api.classes.create(data);
      state.classes.push(created);
      const addedLabel = tabItemLabel(tabId);
      toast(`Added ${article(addedLabel)} ${addedLabel} "${data.name}"`, 'success');

      // Undo removes the group again; redo re-creates it (new id each time, so
      // the action tracks whichever id is currently live).
      history.push({
        liveId: created.id,
        async undo() {
          const gone   = this.liveId;
          const hwHere = state.homework.filter(h => h.classId === gone);
          if (hwHere.length && !await showConfirm({
            title: `Undo "${data.name}"?`,
            message: `Removing this ${addedLabel.toLowerCase()} also deletes ${hwHere.length} assignment${hwHere.length !== 1 ? 's' : ''} added to it.`,
            confirmText: 'Undo', icon: '↩️'
          })) throw new Error(CANCELLED);
          await api.classes.remove(gone);
          state.classes  = state.classes.filter(c => c.id !== gone);
          state.folders  = state.folders.filter(f => f.classId !== gone);
          state.homework = state.homework.filter(h => h.classId !== gone);
          renderSettingsClassList(); renderSchedule(); renderSummary();
          toast(`Removed ${addedLabel.toLowerCase()} "${data.name}"`, 'info');
        },
        async redo() {
          const again = await api.classes.create(data);
          this.liveId = again.id;
          state.classes.push(again);
          renderSettingsClassList(); renderSchedule(); renderSummary();
          toast(`Added ${article(addedLabel)} ${addedLabel} "${data.name}"`, 'success');
        }
      });
    }
    closeGroupForm();
    renderSettingsClassList();
    renderSchedule();
    renderSummary();
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleAddTab(e) {
  e.preventDefault();
  const name = document.getElementById('tab-name').value.trim();
  if (!name) return;
  const submitBtn = document.getElementById('tab-form-submit');
  submitBtn.disabled = true;
  const prevActiveTabId = state.activeTabId;
  try {
    const tab = await api.tabs.create({ name });
    state.tabs.push(tab);
    document.getElementById('tab-name').value = '';
    state.activeTabId = tab.id;
    renderTabBar();
    renderSettingsTabsList();
    populateSettingsTabSelect(tab.id);
    renderSettingsClassList();
    closeSettings();
    renderSchedule();
    toast(`Added space "${name}"`, 'success');

    history.push({
      liveId: tab.id,
      async undo() {
        const gone   = this.liveId;
        const clsIds = state.classes.filter(c => c.tabId === gone).map(c => c.id);
        const hwHere = state.homework.filter(h => clsIds.includes(h.classId));
        if (clsIds.length && !await showConfirm({
          title: `Undo space "${name}"?`,
          message: `Removing it also deletes ${clsIds.length} group${clsIds.length !== 1 ? 's' : ''} and ${hwHere.length} assignment${hwHere.length !== 1 ? 's' : ''} inside it.`,
          confirmText: 'Undo', icon: '↩️'
        })) throw new Error(CANCELLED);
        await api.tabs.remove(gone);
        state.tabs     = state.tabs.filter(t => t.id !== gone);
        state.classes  = state.classes.filter(c => c.tabId !== gone);
        state.folders  = state.folders.filter(f => !clsIds.includes(f.classId));
        state.homework = state.homework.filter(h => !clsIds.includes(h.classId));
        if (state.activeTabId === gone) {
          state.activeTabId = state.tabs.some(t => t.id === prevActiveTabId)
            ? prevActiveTabId
            : (state.tabs[0]?.id ?? null);
        }
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Removed space "${name}"`, 'info');
      },
      async redo() {
        const again = await api.tabs.create({ name });
        this.liveId = again.id;
        state.tabs.push(again);
        state.activeTabId = again.id;
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(again.id); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Added space "${name}"`, 'success');
      }
    });
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleDeleteTab(tabId) {
  const tab    = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const tabCls = state.classes.filter(c => c.tabId === tabId);
  const hwCount = state.homework.filter(h => tabCls.some(c => c.id === h.classId)).length;
  const subMsg = tabCls.length
    ? `This will also delete ${tabCls.length} topic${tabCls.length !== 1 ? 's' : ''} and ${hwCount} assignment${hwCount !== 1 ? 's' : ''}.`
    : '';
  if (!await showConfirm({ title: `Delete "${tab.name}"?`, message: subMsg, confirmText: 'Delete Space', icon: '🗑️' })) return;

  try {
    await api.tabs.remove(tabId);
    const clsIds = tabCls.map(c => c.id);
    state.tabs     = state.tabs.filter(t => t.id !== tabId);
    state.classes  = state.classes.filter(c => c.tabId !== tabId);
    state.folders  = state.folders.filter(f => !clsIds.includes(f.classId));
    state.homework = state.homework.filter(h => !clsIds.includes(h.classId));
    if (state.activeTabId === tabId) state.activeTabId = state.tabs.filter(t => t.id !== tabId)[0]?.id ?? null;

    renderTabBar(); renderSchedule(); renderSummary();
    renderSettingsTabsList();
    populateSettingsTabSelect(state.activeTabId);
    renderSettingsClassList();
    toast(`Deleted space "${tab.name}"`, 'info');

    const { id: _id, createdAt: _ca, ...tabFields } = tab;
    const clsSnapshots = tabCls.map(({ id: _i, tabId: _t, createdAt: _c, ...f }) => f);

    history.push({
      async undo() {
        const restored = await api.tabs.create(tabFields);
        state.tabs.push(restored);
        const restoredCls = await Promise.all(clsSnapshots.map(f => api.classes.create({ ...f, tabId: restored.id })));
        state.classes.push(...restoredCls);
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(restored.id); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Restored space "${tab.name}"`, 'success');
      },
      async redo() {
        const r = state.tabs.find(t => t.name === tab.name && t.id !== 'classes');
        if (!r) return;
        await api.tabs.remove(r.id);
        const rClsIds = state.classes.filter(c => c.tabId === r.id).map(c => c.id);
        state.tabs     = state.tabs.filter(t => t.id !== r.id);
        state.classes  = state.classes.filter(c => c.tabId !== r.id);
        state.folders  = state.folders.filter(f => !rClsIds.includes(f.classId));
        state.homework = state.homework.filter(h => !rClsIds.includes(h.classId));
        if (state.activeTabId === r.id) state.activeTabId = state.tabs.filter(t => t.id !== r.id)[0]?.id ?? null;
        renderTabBar(); renderSchedule(); renderSummary();
        renderSettingsTabsList(); populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
        toast(`Deleted space "${tab.name}"`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleMarkComplete(hwId) {
  // Capture the hw BEFORE any state changes
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;

  try {
    const updated = await api.homework.update(hwId, { completed: true });
    // Merge into state: spread existing fields so nothing is lost, then overlay server response
    const i = state.homework.findIndex(h => h.id === hwId);
    if (i !== -1) state.homework[i] = { ...state.homework[i], ...updated };
    renderSchedule();
    renderSummary();
    toast(`Completed "${hw.description}"`, 'success');

    history.push({
      // Capture description in closure for toast; undo reads fresh from state
      _desc: hw.description,
      async undo() {
        const upd = await api.homework.update(hwId, { completed: false });
        const j = state.homework.findIndex(h => h.id === hwId);
        if (j !== -1) state.homework[j] = { ...state.homework[j], ...upd, completed: false };
        renderSchedule();
        renderSummary();
        toast(`Restored "${this._desc}"`, 'info');
      },
      async redo() {
        const upd = await api.homework.update(hwId, { completed: true });
        const j = state.homework.findIndex(h => h.id === hwId);
        if (j !== -1) state.homework[j] = { ...state.homework[j], ...upd, completed: true };
        renderSchedule();
        renderSummary();
        toast(`Completed "${this._desc}"`, 'success');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* -----------------------------------------------------------------------------
   DELETE — assignments and folders

   One code path for a single right-click delete and for a whole selection. A
   folder in the pile takes its contents with it; use Disband to keep them.
   ----------------------------------------------------------------------------- */
async function deleteItems(keys) {
  const { folders, hw } = itemsInKeys(keys);
  if (!folders.length && !hw.length) return;

  // Count only what's actually on the board. Completed assignments get deleted
  // too, but they're hidden from every view, so naming them here only raises
  // questions about assignments the user has no way to go and look at.
  const active   = hw.filter(h => !h.completed).length;
  const single   = keys.length === 1;
  const title = single && folders.length ? `Delete folder "${folders[0].name}"?`
              : single && hw.length      ? `Delete "${hw[0].description}"?`
              :                            `Delete ${keys.length} items?`;
  const counts = [
    folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : '',
    active         ? `${active} assignment${active === 1 ? '' : 's'}`             : ''
  ].filter(Boolean).join(' and ');
  const message = folders.length
    ? `This deletes ${counts}, including everything inside the folder${folders.length === 1 ? '' : 's'}. Disband a folder instead to keep its assignments.`
    : single ? '' : `This deletes ${counts}.`;

  if (!await showConfirm({ title, message, confirmText: single ? 'Delete' : `Delete ${keys.length} Items`, icon: '🗑️' })) return;

  try {
    await Promise.all(hw.filter(h => h.attachments?.length).map(h => deleteAttachments(h.attachments)));
    await batchDelete([
      ...folders.map(f => userCol('folders').doc(f.id)),
      ...hw.map(h => userCol('homework').doc(h.id))
    ]);

    const goneF = new Set(folders.map(f => f.id));
    const goneH = new Set(hw.map(h => h.id));
    state.folders  = state.folders.filter(f => !goneF.has(f.id));
    state.homework = state.homework.filter(h => !goneH.has(h.id));
    clearSelection();
    renderSchedule();
    renderSummary();
    toast(single && hw.length && !folders.length ? `Deleted "${hw[0].description}"`
        : single && folders.length              ? `Deleted folder "${folders[0].name}"`
        : `Deleted ${keys.length} items`, 'info');

    /* Attachments are already gone from Storage, so they can't come back — but
       `completed` has to survive, or undo puts finished work back on the board.
       Folders come back under their original ids, because every assignment being
       restored alongside them still points at that id through `folderId`. */
    const folderSnaps = folders.map(({ createdAt: _c, ...f }) => f);
    const hwSnaps     = hw.map(({ id: _i, createdAt: _c, attachments: _a, ...f }) => f);
    history.push({
      liveHwIds: [],
      async undo() {
        const rf = await Promise.all(folderSnaps.map(f => api.folders.create(f)));
        state.folders.push(...rf);
        const rh = await Promise.all(hwSnaps.map(f => api.homework.create(f)));
        this.liveHwIds = rh.map(h => h.id);
        state.homework.push(...rh);
        renderSchedule(); renderSummary();
        toast(single ? 'Restored' : `Restored ${keys.length} items`, 'success');
      },
      async redo() {
        await batchDelete([
          ...this.liveHwIds.map(id => userCol('homework').doc(id)),
          ...folderSnaps.map(f => userCol('folders').doc(f.id))
        ]);
        const liveH = new Set(this.liveHwIds);
        const liveF = new Set(folderSnaps.map(f => f.id));
        state.homework = state.homework.filter(h => !liveH.has(h.id));
        state.folders  = state.folders.filter(f => !liveF.has(f.id));
        renderSchedule(); renderSummary();
        toast(single ? 'Deleted' : `Deleted ${keys.length} items`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

function handleDeleteHw(hwId) { return deleteItems([selKey('hw', hwId)]); }

/* -----------------------------------------------------------------------------
   DELETE — groups
   ----------------------------------------------------------------------------- */
async function deleteClasses(ids) {
  const classes = ids.map(id => state.classes.find(c => c.id === id)).filter(Boolean);
  if (!classes.length) return;
  const idSet   = new Set(classes.map(c => c.id));
  const folders = state.folders.filter(f => idSet.has(f.classId));
  const clsHw   = state.homework.filter(h => idSet.has(h.classId));
  const active  = clsHw.filter(h => !h.completed).length;
  const single  = classes.length === 1;
  const label   = tabItemLabel(classes[0].tabId);

  const subMsg = active ? `This will also delete ${active} assignment${active === 1 ? '' : 's'}.` : '';
  if (!await showConfirm({
    title:       single ? `Delete "${classes[0].name}"?` : `Delete ${classes.length} groups?`,
    message:     subMsg,
    confirmText: single ? `Delete ${label}` : `Delete ${classes.length} Groups`,
    icon: '🗑️'
  })) return;

  try {
    for (const c of classes) await api.classes.remove(c.id);
    state.classes  = state.classes.filter(c => !idSet.has(c.id));
    state.folders  = state.folders.filter(f => !idSet.has(f.classId));
    state.homework = state.homework.filter(h => !idSet.has(h.classId));
    clearSelection();
    renderSettingsClassList(); renderSchedule(); renderSummary();
    toast(single ? `Deleted ${label} "${classes[0].name}"` : `Deleted ${classes.length} groups`, 'info');

    // Groups come back with fresh ids, so everything that pointed at one has to
    // be re-pointed. Folders keep their own ids — the assignments being restored
    // beside them still reference those through `folderId`.
    const clsSnaps    = classes.map(({ id, createdAt: _c, ...f }) => ({ origId: id, fields: f }));
    const folderSnaps = folders.map(({ classId, createdAt: _c, ...f }) => ({ origClassId: classId, fields: f }));
    const hwSnaps     = clsHw.map(({ id: _i, classId, createdAt: _c, attachments: _a, ...f }) => ({ origClassId: classId, fields: f }));
    history.push({
      liveClassIds: [],
      async undo() {
        const map = {}, restored = [];
        for (const c of clsSnaps) {
          const r = await api.classes.create(c.fields);
          map[c.origId] = r.id;
          restored.push(r);
        }
        state.classes.push(...restored);
        this.liveClassIds = restored.map(c => c.id);
        const rf = await Promise.all(folderSnaps.map(f => api.folders.create({ ...f.fields, classId: map[f.origClassId] })));
        state.folders.push(...rf);
        const rh = await Promise.all(hwSnaps.map(h => api.homework.create({ ...h.fields, classId: map[h.origClassId] })));
        state.homework.push(...rh);
        resortClasses();
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(single ? `Restored ${label} "${classes[0].name}"` : `Restored ${classes.length} groups`, 'success');
      },
      async redo() {
        if (!this.liveClassIds.length) return;
        const live = new Set(this.liveClassIds);
        for (const id of this.liveClassIds) await api.classes.remove(id);
        state.classes  = state.classes.filter(c => !live.has(c.id));
        state.folders  = state.folders.filter(f => !live.has(f.classId));
        state.homework = state.homework.filter(h => !live.has(h.classId));
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(single ? `Deleted ${label} "${classes[0].name}"` : `Deleted ${classes.length} groups`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

function handleDeleteClass(classId) { return deleteClasses([classId]); }

/* =============================================================================
   FOLDERS

   A folder is a labelled box inside a group. It sits in the group's own ordering
   next to loose assignments, moves as one piece, and can be taken apart two
   ways: disband drops the label and leaves the assignments in place, delete
   takes the assignments with it.
   ============================================================================= */
function promptFolderName({ title, value = '', submitText = 'Create Folder' }) {
  return new Promise(resolve => {
    const modal    = document.getElementById('folder-form-modal');
    const form     = document.getElementById('folder-form');
    const input    = document.getElementById('folder-name');
    const backdrop = document.getElementById('folder-form-backdrop');
    const cancel   = document.getElementById('cancel-folder-form');
    const closeBtn = document.getElementById('close-folder-form');

    document.getElementById('folder-form-title').textContent  = title;
    document.getElementById('folder-form-submit').textContent = submitText;
    input.value = value;

    modal.classList.add('modal--open');
    requestAnimationFrame(() => { input.focus(); input.select(); });

    function cleanup(result) {
      modal.classList.remove('modal--open');
      form.removeEventListener('submit', onSubmit);
      backdrop.removeEventListener('click', onCancel);
      cancel.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onSubmit(e) {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      cleanup(name);
    }
    function onCancel() { cleanup(null); }
    function onKey(e)   { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(null); } }

    form.addEventListener('submit', onSubmit);
    backdrop.addEventListener('click', onCancel);
    cancel.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

async function promptNewFolder(classId, itemKeys = []) {
  const hwKeys = itemKeys.filter(k => k.startsWith('hw:'));
  const first  = hwKeys.map(k => state.homework.find(h => h.id === k.slice(3))).find(Boolean);
  const target = classId || first?.classId;
  if (!target) return;
  const name = await promptFolderName({ title: 'New Folder' });
  if (name === null) return;
  await createFolder(target, name, hwKeys);
}

async function promptRenameFolder(folderId) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;
  const name = await promptFolderName({ title: 'Rename Folder', value: folder.name, submitText: 'Save' });
  if (name === null || name === folder.name) return;
  const prev = folder.name;
  const set = async n => {
    await api.folders.update(folderId, { name: n });
    const f = state.folders.find(x => x.id === folderId);
    if (f) f.name = n;
    renderSchedule();
  };
  try {
    await set(name);
    toast(`Renamed folder to "${name}"`, 'success');
    history.push({
      async undo() { await set(prev); toast(`Renamed folder back to "${prev}"`, 'info'); },
      async redo() { await set(name); toast(`Renamed folder to "${name}"`, 'success'); }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* Create a folder and, optionally, sweep a set of assignments into it. The folder
   lands where the first of those assignments was sitting, so the group's layout
   doesn't jump around underneath the user. */
async function createFolder(classId, name, hwKeys = []) {
  const moving = hwKeys.map(k => state.homework.find(h => h.id === k.slice(3))).filter(Boolean);
  const affected = new Set([classId, ...moving.map(h => h.classId)]);
  const before   = snapshotBoard(affected, moving.map(h => h.id));

  const prevHwOrders = new Map(), prevFolderOrders = new Map();
  state.homework.forEach(h => { if (affected.has(h.classId)) prevHwOrders.set(h.id, h.order); });
  state.folders.forEach(f  => { if (affected.has(f.classId)) prevFolderOrders.set(f.id, f.order); });

  const id     = api.folders.newId();
  const folder = { id, classId, name: name.trim() || 'New Folder', order: 0 };
  const movingKeys = new Set(moving.map(h => selKey('hw', h.id)));

  const top  = groupChildren(classId);
  const at   = top.findIndex(c => movingKeys.has(selKey(c.type, c.id)));
  const rest = top.filter(c => !movingKeys.has(selKey(c.type, c.id)));
  state.folders.push(folder);
  rest.splice(at === -1 ? rest.length : at, 0, { type: 'fd', id, ref: folder });
  rest.forEach((c, i) => { c.ref.order = i; });

  const hwData = new Map();
  moving.forEach((h, i) => {
    const data = { folderId: id };
    if (h.classId !== classId) data.classId = classId;
    hwData.set(h.id, data);
    h.classId = classId; h.folderId = id; h.order = i;
  });

  clearSelection();
  renderSchedule();
  renderSummary();

  try {
    await api.folders.create({ id, classId, name: folder.name, order: folder.order });
    prevFolderOrders.set(id, folder.order); // just written — don't write it twice
    await persistPlacement([...affected], prevHwOrders, prevFolderOrders, hwData, new Map());

    const after = snapshotBoard(affected, moving.map(h => h.id));
    const focus = hwKeys[0] || selKey('fd', id);
    toast(`Created folder "${folder.name}"`, 'success');
    history.push({
      async undo() {
        // Empty it before the doc goes, so the restore isn't laying assignments
        // back into a folder that is about to stop existing.
        state.folders = state.folders.filter(f => f.id !== id);
        await restoreBoard(before, focus);
        await api.folders.remove(id);
        renderSchedule();
        toast(`Removed folder "${folder.name}"`, 'info');
      },
      async redo() {
        await api.folders.create({ id, classId, name: folder.name, order: folder.order });
        if (!state.folders.some(f => f.id === id)) state.folders.push({ ...folder });
        await restoreBoard(after, focus);
        toast(`Created folder "${folder.name}"`, 'success');
      }
    });
  } catch (err) {
    state.folders = state.folders.filter(f => f.id !== id);
    applyBoardLocally(before);
    renderSchedule();
    renderSummary();
    toast(`Could not create folder: ${err.message}`, 'error');
  }
}

/* Disband — drop the label, leave the assignments exactly where they sat, in the
   order they were in, spliced into the group at the folder's own position. */
async function disbandFolder(folderId) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;
  const classId = folder.classId;
  const kids    = state.homework.filter(h => h.folderId === folderId);
  const before  = snapshotBoard([classId], kids.map(h => h.id));
  const snapshot = { id: folderId, classId, name: folder.name, order: folder.order ?? 0 };

  const prevHwOrders = new Map(), prevFolderOrders = new Map();
  state.homework.forEach(h => { if (h.classId === classId) prevHwOrders.set(h.id, h.order); });
  state.folders.forEach(f  => { if (f.classId === classId) prevFolderOrders.set(f.id, f.order); });

  const top   = groupChildren(classId);
  const at    = top.findIndex(c => c.type === 'fd' && c.id === folderId);
  const rest  = top.filter(c => !(c.type === 'fd' && c.id === folderId));
  const inner = folderChildren(folderId);
  rest.splice(at === -1 ? rest.length : at, 0, ...inner);

  const hwData = new Map();
  kids.forEach(h => { hwData.set(h.id, { folderId: null }); h.folderId = null; });
  state.folders = state.folders.filter(f => f.id !== folderId);
  rest.forEach((c, i) => { c.ref.order = i; });

  clearSelection();
  renderSchedule();
  renderSummary();

  try {
    await persistPlacement([classId], prevHwOrders, prevFolderOrders, hwData, new Map());
    await api.folders.remove(folderId);
    toast(`Disbanded folder "${folder.name}"`, 'info');

    const after = snapshotBoard([classId], kids.map(h => h.id));
    const focus = kids[0] ? selKey('hw', kids[0].id) : null;
    history.push({
      async undo() {
        await api.folders.create(snapshot);
        if (!state.folders.some(f => f.id === folderId)) state.folders.push({ ...snapshot });
        await restoreBoard(before, focus);
        toast(`Restored folder "${snapshot.name}"`, 'success');
      },
      async redo() {
        state.folders = state.folders.filter(f => f.id !== folderId);
        await restoreBoard(after, focus);
        await api.folders.remove(folderId);
        renderSchedule();
        toast(`Disbanded folder "${snapshot.name}"`, 'info');
      }
    });
  } catch (err) {
    state.folders.push({ ...snapshot });
    applyBoardLocally(before);
    renderSchedule();
    renderSummary();
    toast(`Could not disband folder: ${err.message}`, 'error');
  }
}

/* =============================================================================
   SCHEDULE TRANSFER
   ============================================================================= */
function downloadSchedule() {
  const idMap = {};
  state.classes.forEach(c => { idMap[c.id] = c.id; });

  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    tabs: state.tabs.map(({ id, createdAt: _c, ...rest }) => ({ _origId: id, ...rest })),
    classes: state.classes.map(({ id, createdAt: _c, ...rest }) => ({ _origId: id, ...rest })),
    folders: state.folders.map(({ id, createdAt: _c, ...rest }) => ({ _origId: id, ...rest })),
    homework: state.homework
      .filter(h => !h.completed)
      .map(({ id, createdAt: _c, completed: _co, ...rest }) => ({ _origId: id, ...rest }))
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `studyflow-schedule-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Schedule downloaded', 'success');
}

async function loadSchedule(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Invalid file — could not parse JSON', 'error');
    return;
  }
  if (!data.tabs || !data.classes) {
    toast('Invalid schedule file', 'error');
    return;
  }
  if (!await showConfirm({ title: 'Replace current schedule?', message: 'This will delete all your existing spaces, topics, and assignments.', confirmText: 'Replace', icon: '⚠️' })) return;

  try {
    // Delete all existing data
    await Promise.all(state.homework.map(h => api.homework.remove(h.id)));
    await Promise.all(state.folders.map(f => api.folders.remove(f.id)));
    await Promise.all(state.classes.map(c => api.classes.remove(c.id)));
    await Promise.all(state.tabs.map(t => api.tabs.remove(t.id)));

    state.tabs     = [];
    state.classes  = [];
    state.folders  = [];
    state.homework = [];

    // Rebuild with new IDs, tracking the old→new mapping
    const tabIdMap = {};
    for (const t of data.tabs) {
      const { _origId, ...body } = t;
      const created = await api.tabs.create(body);
      state.tabs.push(created);
      tabIdMap[_origId] = created.id;
    }

    const clsIdMap = {};
    for (const c of data.classes) {
      const { _origId, tabId, ...body } = c;
      const newTabId = tabIdMap[tabId];
      if (!newTabId) continue;
      const created  = await api.classes.create({ ...body, tabId: newTabId });
      state.classes.push(created);
      clsIdMap[_origId] = created.id;
    }

    const folderIdMap = {};
    for (const f of (data.folders || [])) {
      const { _origId, classId, ...body } = f;
      const newClassId = clsIdMap[classId];
      if (!newClassId) continue;
      const created = await api.folders.create({ ...body, classId: newClassId });
      state.folders.push(created);
      folderIdMap[_origId] = created.id;
    }

    for (const h of (data.homework || [])) {
      const { _origId, classId, folderId, ...body } = h;
      const newClassId = clsIdMap[classId];
      if (!newClassId) continue;
      const created = await api.homework.create({
        ...body, classId: newClassId,
        ...(folderId && folderIdMap[folderId] && { folderId: folderIdMap[folderId] })
      });
      state.homework.push(created);
    }
    resortClasses();

    if (!state.activeTabId || !state.tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();
    populateSettingsTabSelect(state.activeTabId);
    renderSettingsTabsList();
    renderSettingsClassList();
    toast('Schedule loaded successfully', 'success');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
    console.error(err);
  }
}

/* =============================================================================
   TEMPLATES
   ============================================================================= */
async function applyTemplate(btnId, templateName, tabs) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  try {
    let firstTabId = null;
    for (const tabDef of tabs) {
      const tab = await api.tabs.create({ name: tabDef.name });
      state.tabs.push(tab);
      if (!firstTabId) firstTabId = tab.id;
      for (const cls of tabDef.classes) {
        const created = await api.classes.create({ ...cls, tabId: tab.id });
        state.classes.push(created);
      }
    }

    state.activeTabId = firstTabId;
    renderTabBar();
    renderSchedule();
    renderSummary();
    renderSettingsTabsList();
    populateSettingsTabSelect(firstTabId);
    renderSettingsClassList();
    openSettings('classes');
    toast(`${templateName} template applied — edit your topics below`, 'success');
  } catch (err) {
    toast(`Template failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function applyStudentTemplate() {
  return applyTemplate('student-template-btn', 'High School', [
    { name: 'Classes', classes: [
      { name: 'English',  color: '#ef4444' },
      { name: 'Math',     color: '#3b82f6' },
      { name: 'Science',  color: '#22c55e' },
      { name: 'History',  color: '#f97316' },
      { name: 'Elective', color: '#8b5cf6' },
      { name: 'Elective', color: '#ec4899' },
      { name: 'Elective', color: '#14b8a6' },
      { name: 'Elective', color: '#eab308' },
    ]},
  ]);
}

function applyCollegeTemplate() {
  return applyTemplate('college-template-btn', 'College', [
    { name: 'Classes', classes: [
      { name: 'Major Course 1', color: '#3b82f6' },
      { name: 'Major Course 2', color: '#6366f1' },
      { name: 'Major Course 3', color: '#8b5cf6' },
      { name: 'Gen Ed 1',       color: '#22c55e' },
      { name: 'Gen Ed 2',       color: '#14b8a6' },
      { name: 'Elective 1',     color: '#f97316' },
      { name: 'Elective 2',     color: '#eab308' },
    ]},
  ]);
}

function applyWorkTemplate() {
  return applyTemplate('work-template-btn', 'Work', [
    { name: 'Work', classes: [
      { name: 'Projects',    color: '#3b82f6' },
      { name: 'Meetings',    color: '#8b5cf6' },
      { name: 'Tasks',       color: '#22c55e' },
      { name: 'Follow-ups',  color: '#f97316' },
      { name: 'Admin',       color: '#64748b' },
    ]},
  ]);
}

function applyPersonalTemplate() {
  return applyTemplate('personal-template-btn', 'Personal', [
    { name: 'Personal', classes: [
      { name: 'Errands',      color: '#22c55e' },
      { name: 'Appointments', color: '#3b82f6' },
      { name: 'Goals',        color: '#8b5cf6' },
      { name: 'Reminders',    color: '#f97316' },
      { name: 'Health',       color: '#ef4444' },
    ]},
  ]);
}

/* =============================================================================
   PUSH NOTIFICATIONS
   This half only registers the subscription; sw.js displays what arrives. The
   sending half can't live here — it has to run when the browser is closed — so
   it's a GitHub Actions cron, notifier/send-reminders.js.

   This key must stay in sync with the VAPID_PUBLIC_KEY secret that job signs
   with. Changing it invalidates every subscription already in Firestore, and
   each device has to toggle notifications off and back on.
   ============================================================================= */
const VAPID_PUBLIC_KEY = 'BKGl9PmZmTbSavV-2JK3Lh45XxxCkd3un6Gf8eK3hMbCFuvPsQ3wKagCChxP5qy0n6VVmfmtapaeeueImwOdjVY';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* An existing subscription reports its key as an ArrayBuffer. Treat "the browser
   didn't tell us" as a mismatch — resubscribing costs one round trip, while
   guessing wrong leaves a subscription no push can ever reach. */
function sameApplicationServerKey(existing, wanted) {
  if (!existing) return false;
  const bytes = new Uint8Array(existing);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (e) { console.warn('SW registration failed:', e); }
}

async function subscribeToNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = navigator.standalone === true;
    if (isIOS && !isStandalone) {
      toast('Tap the share icon → "Add to Home Screen", then open the app from your home screen to enable notifications.', 'warning');
    } else {
      toast('Push notifications are not supported in this browser.', 'warning');
    }
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Notification permission denied.', 'warning');
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    renderPrefsPage();
    return;
  }
  try {
    const reg    = await navigator.serviceWorker.ready;
    const appKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

    /* A subscription created under a different VAPID key can't be replaced by
       subscribing over it — the browser throws "Provided applicationServerKey
       does not match the key in the existing subscription". Toggling off would
       clear it, but that's no help to anyone whose toggle already reads off
       (a failed attempt leaves it that way), so retire the stale one here.
       Its Firestore document goes too: the endpoint is about to change, and
       nothing else would ever clean up the orphan. */
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameApplicationServerKey(sub.options?.applicationServerKey, appKey)) {
      try { await api.notifications.unsubscribe(sub.endpoint); } catch (_) {}
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: appKey
      });
    }
    const notifyBefore = prefs.get('notifyBefore', 60);
    await api.notifications.subscribe(sub.toJSON(), notifyBefore);
    prefs.set('notificationsEnabled', true);
    prefs.set('pushEndpoint', sub.endpoint);
    renderPrefsPage();
    toast('Notifications enabled', 'success');
  } catch (e) {
    toast(`Could not enable notifications: ${e.message}`, 'error');
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    renderPrefsPage();
  }
}

async function unsubscribeFromNotifications() {
  try {
    const endpoint = prefs.get('pushEndpoint', null);
    if (endpoint) {
      await api.notifications.unsubscribe(endpoint);
    }
    const reg = await navigator.serviceWorker?.ready;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
    prefs.set('notificationsEnabled', false);
    prefs.set('pushEndpoint', null);
    renderPrefsPage();
    toast('Notifications disabled', 'success');
  } catch (e) { toast(`Error disabling notifications: ${e.message}`, 'error'); }
}

/* =============================================================================
   WIRE EVENTS
   ============================================================================= */
function buildTimePickerOptions() {
  const hourList = document.getElementById('hw-hour-list');
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement('option'); opt.value = String(h); hourList.appendChild(opt);
  }
  const minList = document.getElementById('hw-min-list');
  for (let m = 0; m <= 59; m++) {
    const opt = document.createElement('option'); opt.value = String(m).padStart(2, '0'); minList.appendChild(opt);
  }
  document.getElementById('hw-minute').addEventListener('blur', e => {
    const v = e.target.value.trim();
    if (v !== '' && !isNaN(v)) e.target.value = String(parseInt(v)).padStart(2, '0');
  });
}

function wireEvents() {
  buildTimePickerOptions();
  document.getElementById('add-hw-btn').addEventListener('click', () => openHwModal());
  document.getElementById('settings-btn').addEventListener('click', () => openSettings('account'));
  document.getElementById('empty-settings-btn').addEventListener('click', () => openSettings('tabs'));
  document.getElementById('empty-template-btn').addEventListener('click', () => openSettings('templates'));
  document.getElementById('empty-add-group-btn').addEventListener('click', () => {
    populateSettingsTabSelect(state.activeTabId);
    resetClassForm();
    openGroupForm();
  });
  document.getElementById('user-avatar').addEventListener('click', () => openSettings('account'));

  document.getElementById('undo-btn').addEventListener('click', () => history.undo());
  document.getElementById('redo-btn').addEventListener('click', () => history.redo());

  // Clicking away from the board drops the selection — but not onto the context
  // menu or the selection bar, both of which are there to act on it.
  document.addEventListener('click', e => {
    if (!sel.ids.size) return;
    if (e.target.closest('#classes-container, #context-menu, #selection-bar, .modal')) return;
    clearSelection();
  });
  document.getElementById('selection-clear').addEventListener('click', clearSelection);
  document.getElementById('selection-actions').addEventListener('click', e => {
    // Same menu the right-click gives, anchored to the bar
    const keys = selectionKeys();
    if (!keys.length) return;
    const [type, id] = splitKey(keys[0]);
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu(r.left, r.top - 8, type === 'fd' ? 'folder' : type === 'cls' ? 'class' : 'hw', id);
  });

  document.getElementById('hw-form').addEventListener('submit', handleAddHomework);
  document.getElementById('close-hw-modal').addEventListener('click', closeHwModal);
  document.getElementById('cancel-hw').addEventListener('click', closeHwModal);
  document.getElementById('hw-backdrop').addEventListener('click', closeHwModal);

  document.getElementById('hw-attach-btn').addEventListener('click', () => document.getElementById('hw-attach-input').click());
  document.getElementById('hw-attach-input').addEventListener('change', e => {
    handleAttachFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('lightbox').addEventListener('click', e => {
    if (!e.target.closest('.lightbox-img')) closeLightbox();
  });
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);

  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('class-form').addEventListener('submit', handleClassFormSubmit);
  document.getElementById('cancel-edit-class').addEventListener('click', closeGroupForm);
  document.getElementById('add-group-btn').addEventListener('click', () => { resetClassForm(); openGroupForm(); });
  document.getElementById('close-group-form').addEventListener('click', closeGroupForm);
  document.getElementById('group-form-backdrop').addEventListener('click', closeGroupForm);
  document.getElementById('tab-form').addEventListener('submit', handleAddTab);
  document.getElementById('settings-tab-select').addEventListener('change', () => {
    renderSettingsClassList();
    updateSettingsLabels();
    if (!document.getElementById('edit-class-id').value) {
      selectSwatch(getNextAvailableColor(document.getElementById('settings-tab-select').value || 'classes'));
    }
  });

  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.page) switchSettingsPage(btn.dataset.page); });
  });

  // Account page
  document.getElementById('settings-sign-out-btn').addEventListener('click', () => auth.signOut());

  // Preferences page
  document.getElementById('theme-cards').addEventListener('click', e => {
    const card = e.target.closest('.theme-card');
    if (!card) return;
    prefs.set('theme', card.dataset.theme);
    applyPrefs();
    renderPrefsPage();
  });
  document.getElementById('pref-compact').addEventListener('change', e => {
    prefs.set('compact', e.target.checked);
    applyPrefs();
  });
  document.getElementById('pref-summary').addEventListener('change', e => {
    prefs.set('showSummary', e.target.checked);
    applyPrefs();
    const chev = document.getElementById('summary-drag-chevron');
    if (chev) chev.textContent = e.target.checked ? '‹' : '›';
  });

  // Summary panel drag-to-collapse
  (function() {
    const handle  = document.getElementById('summary-drag-handle');
    const panel   = document.querySelector('.summary-panel');
    const appBody = document.querySelector('.app-body');
    if (!handle || !panel || !appBody) return;

    function isMobile() { return window.innerWidth <= 820; }

    // ── Desktop drag (horizontal) ──────────────────────────────────────────────
    const D_EXPANDED = 340, D_COLLAPSED = 16, D_SNAP = 120;
    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      if (isMobile()) return;
      dragging = true; startX = e.clientX; startW = panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging || isMobile()) return;
      const w = Math.max(D_COLLAPSED, Math.min(D_EXPANDED, startW - (e.clientX - startX)));
      appBody.style.gridTemplateColumns = `1fr ${w}px`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      const collapse = panel.offsetWidth < D_SNAP;
      appBody.style.gridTemplateColumns = '';
      setDesktopCollapsed(collapse);
    });
    handle.addEventListener('click', e => {
      if (isMobile() || Math.abs(e.clientX - startX) > 4) return;
      setDesktopCollapsed(!panel.classList.contains('summary-panel--collapsed'));
    });
    function setDesktopCollapsed(collapse) {
      panel.classList.toggle('summary-panel--collapsed', collapse);
      const chev = document.getElementById('summary-drag-chevron');
      if (chev) chev.textContent = collapse ? '›' : '‹';
      prefs.set('showSummary', !collapse);
      const tog = document.getElementById('pref-summary');
      if (tog) tog.checked = !collapse;
    }
    // Init desktop chevron
    const initChev = document.getElementById('summary-drag-chevron');
    if (initChev) initChev.textContent = panel.classList.contains('summary-panel--collapsed') ? '›' : '‹';

    // ── Mobile drag (vertical, 3-snap bottom sheet) ────────────────────────────
    function getSafeAreaBottom() {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
      document.body.appendChild(el);
      const h = el.offsetHeight;
      el.remove();
      return h;
    }
    const M_SAFE_BOTTOM = navigator.standalone ? getSafeAreaBottom() : 0;
    const M_COLLAPSED = 36 + M_SAFE_BOTTOM;
    const M_NORMAL    = 240;
    const M_EXPANDED  = () => Math.round(window.innerHeight * 0.86);

    let mobileSnap = 'normal'; // 'collapsed' | 'normal' | 'expanded'
    let touching = false, touchStartY = 0, touchStartH = 0, touchStartTime = 0;

    function getCurrentMobileH() {
      const rows = appBody.style.gridTemplateRows;
      if (rows) { const m = rows.match(/(\d+(?:\.\d+)?)px/); if (m) return parseFloat(m[1]); }
      return mobileSnap === 'collapsed' ? M_COLLAPSED
           : mobileSnap === 'expanded'  ? M_EXPANDED()
           : M_NORMAL;
    }

    function snapMobileTo(snap, animate) {
      const h = snap === 'expanded' ? M_EXPANDED() : snap === 'normal' ? M_NORMAL : M_COLLAPSED;
      if (animate) {
        appBody.style.transition = 'grid-template-rows 230ms cubic-bezier(.4,0,.2,1)';
        setTimeout(() => { appBody.style.transition = ''; }, 240);
      }
      appBody.style.gridTemplateRows = `1fr ${h}px`;
      panel.classList.toggle('summary-panel--collapsed', snap === 'collapsed');
      mobileSnap = snap;
      prefs.set('mobileSummarySnap', snap);
      prefs.set('showSummary', snap !== 'collapsed');
      const tog = document.getElementById('pref-summary');
      if (tog) tog.checked = snap !== 'collapsed';
    }

    function nearestSnap(h) {
      const exp = M_EXPANDED();
      const dC = Math.abs(h - M_COLLAPSED), dN = Math.abs(h - M_NORMAL), dE = Math.abs(h - exp);
      const min = Math.min(dC, dN, dE);
      return min === dC ? 'collapsed' : min === dN ? 'normal' : 'expanded';
    }

    handle.addEventListener('touchstart', e => {
      if (!isMobile()) return;
      touching = true;
      touchStartY = e.touches[0].clientY;
      touchStartH = getCurrentMobileH();
      touchStartTime = Date.now();
      appBody.style.transition = '';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', e => {
      if (!touching) return;
      const dy = touchStartY - e.touches[0].clientY;
      const h  = Math.max(M_COLLAPSED - 10, Math.min(M_EXPANDED() + 30, touchStartH + dy));
      appBody.style.gridTemplateRows = `1fr ${h}px`;
      panel.classList.toggle('summary-panel--collapsed', h < M_COLLAPSED + 16);
    }, { passive: true });

    document.addEventListener('touchend', e => {
      if (!touching) return;
      touching = false;
      const isTap = Date.now() - touchStartTime < 260
                 && Math.abs(touchStartY - (e.changedTouches[0]?.clientY ?? touchStartY)) < 12;
      if (isTap) {
        const next = mobileSnap === 'collapsed' ? 'normal'
                   : mobileSnap === 'expanded'  ? 'normal'
                   : 'collapsed';
        snapMobileTo(next, true);
      } else {
        snapMobileTo(nearestSnap(getCurrentMobileH()), true);
      }
    });

    // Init mobile snap state
    if (isMobile()) {
      const saved = prefs.get('mobileSummarySnap', prefs.get('showSummary', true) ? 'normal' : 'collapsed');
      mobileSnap = saved;
      snapMobileTo(saved, false);
    }
  })();
  document.getElementById('pref-notifications').addEventListener('change', e => {
    if (e.target.checked) subscribeToNotifications();
    else unsubscribeFromNotifications();
  });
  document.getElementById('pref-notify-before').addEventListener('change', async e => {
    const val = parseInt(e.target.value);
    prefs.set('notifyBefore', val);
    try { await api.notifications.setPrefs(val); }
    catch (_) {}
  });
  // TEST BUTTON — there is no endpoint to call any more; reminders are sent by a
  // GitHub Actions cron (notifier/send-reminders.js), which nothing in the
  // browser can trigger. To send a test push, run that workflow with mode=test.
  // document.getElementById('pref-notify-test-btn').addEventListener('click', async e => {
  //   const btn = e.currentTarget;
  //   btn.disabled = true;
  //   btn.textContent = 'Sending…';
  //   try {
  //     const result = await apiFetch('POST', '/api/notifications/test', {});
  //     toast('Test notification sent!', 'success');
  //     if (result?.debug) console.log('[notif test debug]', result.debug);
  //   } catch (err) {
  //     toast(`Test failed: ${err.message}`, 'error');
  //     console.error('[notif test error]', err);
  //   } finally {
  //     btn.disabled = false;
  //     btn.textContent = 'Send Test';
  //   }
  // });

  // Show/hide reminder group when deadline is set/cleared
  document.getElementById('hw-deadline').addEventListener('change', e => {
    document.getElementById('hw-reminder-group').classList.toggle('hidden', !e.target.value);
    if (!e.target.value) document.getElementById('hw-reminder').value = '';
  });

  // Schedule transfer
  document.getElementById('download-schedule-btn').addEventListener('click', downloadSchedule);
  document.getElementById('load-schedule-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) { loadSchedule(file); e.target.value = ''; }
  });

  document.getElementById('settings-tabs-list').addEventListener('click', e => {
    const deleteBtn = e.target.closest('.delete-tab-btn');
    const editBtn   = e.target.closest('.edit-tab-btn');
    if (deleteBtn) handleDeleteTab(deleteBtn.dataset.tabId);
    if (editBtn) {
      const tabId  = editBtn.dataset.tabId;
      const tab    = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      const item   = editBtn.closest('.settings-tab-item');
      const nameEl = item.querySelector('.settings-tab-name');
      const input  = document.createElement('input');
      input.type        = 'text';
      input.value       = tab.name;
      input.className   = 'inline-tab-rename';
      input.style.cssText = 'flex:1;font-size:.9rem;font-weight:600;border:1px solid var(--border);border-radius:4px;padding:2px 6px;background:var(--bg);color:var(--text);';
      nameEl.replaceWith(input);
      editBtn.textContent = 'Save';
      input.focus();
      input.select();

      // Clicking Save blurs the input first, and cancelling re-renders the list
      // (which also blurs it) — so guard against the commit running twice or
      // running at all after the user backed out.
      let settled = false;
      async function commitRename() {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (newName && newName !== tab.name) {
          try {
            await api.tabs.update(tabId, { name: newName });
            tab.name = newName;
            renderTabBar();
            populateSettingsTabSelect(state.activeTabId);
            toast(`Renamed space to "${newName}"`, 'success');
          } catch (err) {
            toast(`Error: ${err.message}`, 'error');
          }
        }
        renderSettingsTabsList();
      }
      function cancelRename() {
        if (settled) return;
        settled = true;
        renderSettingsTabsList();
      }

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
      });
      input.addEventListener('blur', commitRename);
      editBtn.addEventListener('click', e => { e.stopPropagation(); commitRename(); }, { once: true });
    }
  });

  document.getElementById('settings-classes-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('.edit-class-btn');
    const deleteBtn = e.target.closest('.delete-class-btn');
    if (editBtn)   { const cls = state.classes.find(c => c.id === editBtn.dataset.classId);   if (cls) startEditClass(cls); }
    if (deleteBtn) { handleDeleteClass(deleteBtn.dataset.classId); }
  });

  // Main schedule — all delegated
  document.getElementById('classes-container').addEventListener('change', e => {
    const cb = e.target.closest('.hw-check');
    if (cb) handleMarkComplete(cb.dataset.hwId);
  });

  // Shift-click builds a selection, so don't let it also sweep a text highlight
  // across everything it touches.
  const board = document.getElementById('classes-container');
  board.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });

  // Custom context menu — desktop right-click
  board.addEventListener('contextmenu', e => {
    const hwItem   = e.target.closest('.hw-item');
    const folderEl = e.target.closest('.folder-header') && e.target.closest('.folder');
    const row      = e.target.closest('.class-row');
    if (hwItem)        { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'hw',     hwItem.dataset.hwId); }
    else if (folderEl) { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'folder', folderEl.dataset.folderId); }
    else if (row)      { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'class',  row.dataset.classId); }
  });

  // Custom context menu — touch long-press (excludes drag handles + controls)
  let lpTimer = null, lpXY = null;
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  board.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('.hw-drag-handle, .class-drag-handle, .folder-drag-handle, button, a, input, label')) return;
    const hwItem   = e.target.closest('.hw-item');
    const folderEl = e.target.closest('.folder-header') && e.target.closest('.folder');
    const row      = e.target.closest('.class-row');
    const target = hwItem   ? ['hw',     hwItem.dataset.hwId]
                 : folderEl ? ['folder', folderEl.dataset.folderId]
                 : row      ? ['class',  row.dataset.classId]
                 : null;
    if (!target) return;
    lpXY = { x: e.clientX, y: e.clientY };
    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      openContextMenu(lpXY.x, lpXY.y, target[0], target[1]);
      // Swallow the trailing click so the item doesn't also expand/collapse.
      const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); document.removeEventListener('click', swallow, true); };
      document.addEventListener('click', swallow, true);
    }, 500);
  });
  board.addEventListener('pointermove', e => {
    if (lpTimer && lpXY && Math.hypot(e.clientX - lpXY.x, e.clientY - lpXY.y) > 8) cancelLP();
  });
  board.addEventListener('pointerup',     cancelLP);
  board.addEventListener('pointercancel', cancelLP);
  document.getElementById('classes-container').addEventListener('click', e => {
    // Ctrl/Cmd- and Shift-click build a selection instead of doing whatever the
    // click would normally do to the thing under the cursor.
    const mod = e.metaKey || e.ctrlKey;
    // A modifier held over a control still means the control: Ctrl-clicking a
    // checkbox marks the assignment done rather than half-selecting it.
    if ((mod || e.shiftKey) && !e.target.closest('button, a, input, label')) {
      const target = e.target.closest('.hw-item, .folder-header, .class-header');
      if (target) {
        e.preventDefault();
        const key = target.classList.contains('hw-item')     ? selKey('hw', target.dataset.hwId)
                  : target.classList.contains('folder-header') ? selKey('fd', target.closest('.folder').dataset.folderId)
                  :                                              selKey('cls', target.closest('.class-row').dataset.classId);
        handleSelectClick(key, mod, e.shiftKey);
        return;
      }
    }
    // Any other click on the board drops the selection, the way clicking away
    // from a selection does everywhere else.
    if (sel.ids.size && !e.target.closest('button, a, input, label')) clearSelection();

    const editBtn   = e.target.closest('.hw-edit-btn');
    const delBtn    = e.target.closest('.hw-delete');
    const addBtn    = e.target.closest('.class-add-hw-btn');
    const folderAdd = e.target.closest('.folder-add-btn');
    if (editBtn)   { openHwEditModal(editBtn.dataset.hwId); return; }
    if (delBtn)    { handleDeleteHw(delBtn.dataset.hwId);   return; }
    if (addBtn)    { openHwModal(addBtn.dataset.classId);   return; }
    if (folderAdd) {
      const folder = state.folders.find(f => f.id === folderAdd.dataset.folderId);
      if (folder) openHwModal(folder.classId, folder.id);
      return;
    }

    // Toggle a folder open/closed (click anywhere on its header)
    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader && !e.target.closest('.folder-drag-handle')) {
      const el = folderHeader.closest('.folder');
      const collapsed = el.classList.toggle('folder--collapsed');
      folderHeader.querySelector('.folder-toggle-btn').textContent = collapsed ? '▸' : '▾';
      folderHeader.querySelector('.folder-toggle-btn').setAttribute('aria-expanded', String(!collapsed));
      folderHeader.querySelector('.folder-icon').textContent = collapsed ? '📁' : '📂';
      const ids = new Set(prefs.get('collapsedFolders', []));
      if (collapsed) ids.add(el.dataset.folderId); else ids.delete(el.dataset.folderId);
      prefs.set('collapsedFolders', [...ids]);
      return;
    }

    // Attachment image → lightbox
    const attachImg = e.target.closest('.hw-attach-img');
    if (attachImg) { openLightbox(attachImg.dataset.lightbox); return; }

    // Toggle topic collapse (click anywhere on header except + Add / drag handle)
    const header = e.target.closest('.class-header');
    if (header && !e.target.closest('.class-drag-handle')) {
      const row = header.closest('.class-row');
      const collapsed = row.classList.toggle('class-row--collapsed');
      const toggleBtn = header.querySelector('.class-toggle-btn');
      if (toggleBtn) {
        toggleBtn.textContent = collapsed ? '▸' : '▾';
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      }
      // Persist collapsed state
      const classId = row.dataset.classId;
      const ids = Array.isArray(prefs.get('collapsedTopics', [])) ? prefs.get('collapsedTopics', []) : [];
      if (collapsed) { if (!ids.includes(classId)) ids.push(classId); }
      else           { const i = ids.indexOf(classId); if (i !== -1) ids.splice(i, 1); }
      prefs.set('collapsedTopics', ids);
      return;
    }

    // Toggle hw-item expand/collapse (click anywhere on item except interactive controls)
    const hwItem = e.target.closest('.hw-item--collapsible');
    if (hwItem && !e.target.closest('.hw-check-label') && !e.target.closest('.hw-edit-btn') && !e.target.closest('.hw-delete') && !e.target.closest('.hw-attach-file') && !e.target.closest('.hw-drag-handle')) {
      const expanded = hwItem.classList.toggle('hw-item--expanded');
      const hint = hwItem.querySelector('.hw-expand-hint');
      if (hint) hint.textContent = expanded ? '▴ less' : '▾ more';
      const ids = new Set(prefs.get('expandedHw', []));
      if (expanded) ids.add(hwItem.dataset.hwId);
      else ids.delete(hwItem.dataset.hwId);
      prefs.set('expandedHw', [...ids]);
    }
  });

  // Summary panel — edit, complete, and no-date section toggle
  document.getElementById('summary-list').addEventListener('click', e => {
    const toggle = e.target.closest('.summary-nodate-toggle');
    if (toggle) {
      const section = toggle.closest('.summary-nodate-section');
      const collapsed = section.classList.toggle('summary-nodate-section--collapsed');
      toggle.querySelector('.summary-nodate-chevron').textContent = collapsed ? '▾' : '▴';
      prefs.set('summaryNodateCollapsed', collapsed);
      return;
    }
    const editBtn = e.target.closest('.summary-btn--edit');
    const doneBtn = e.target.closest('.summary-btn--done');
    if (editBtn) openHwEditModal(editBtn.dataset.hwId);
    if (doneBtn) handleMarkComplete(doneBtn.dataset.hwId);
  });

  // Help section modals
  function openModal(id)  { document.getElementById(id).classList.add('modal--open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('modal--open'); }

  document.getElementById('student-template-btn').addEventListener('click',  applyStudentTemplate);
  document.getElementById('college-template-btn').addEventListener('click',  applyCollegeTemplate);
  document.getElementById('work-template-btn').addEventListener('click',     applyWorkTemplate);
  document.getElementById('personal-template-btn').addEventListener('click', applyPersonalTemplate);

  document.getElementById('whats-new-btn').addEventListener('click',  () => openModal('whats-new-modal'));
  document.getElementById('privacy-btn').addEventListener('click',     () => openModal('privacy-modal'));
  document.getElementById('close-whats-new').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('close-privacy').addEventListener('click',   () => closeModal('privacy-modal'));
  document.getElementById('whats-new-backdrop').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('privacy-backdrop').addEventListener('click',   () => closeModal('privacy-modal'));

  // FAQ accordion
  document.querySelector('.faq-list').addEventListener('click', e => {
    const btn = e.target.closest('.faq-question');
    if (!btn) return;
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    // Let the browser handle undo/redo while the user is editing text.
    const el  = e.target;
    const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (mod && !typing && e.key==='z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
    if (mod && !typing && (e.key==='y' || (e.key==='z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
    if (e.key==='Escape') {
      if (!document.getElementById('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      if (sel.ids.size && !document.querySelector('.modal--open')) { clearSelection(); return; }
      closeHwModal(); closeSettings(); closeGroupForm();
      closeModal('whats-new-modal'); closeModal('privacy-modal');
    }
  });
}

/* =============================================================================
   INIT
   ============================================================================= */
let _appBooted = false;
async function init() {
  if (!_appBooted) {
    _appBooted = true;
    initColorSwatches();
    initAccentSwatches();
    wireEvents();
    applyPrefs();
    registerServiceWorker();
  }
  document.getElementById('classes-container').innerHTML = `
    <div class="data-loading">
      <div class="spinner"></div>
      <p>Loading your data…</p>
    </div>`;
  document.getElementById('empty-state').classList.add('hidden');

  try {
    const [tabs, classes, folders, homework] = await Promise.all([
      api.tabs.list(),
      api.classes.list(),
      api.folders.list(),
      api.homework.list()
    ]);
    state.tabs     = tabs;
    state.classes  = classes;
    state.folders  = folders;
    state.homework = homework;
    resortClasses();
    _lastRefresh   = Date.now();
    if (!state.activeTabId || !tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();

    // Sync notifyBefore from Firestore so all devices share one preference
    api.notifications.getPrefs().then(r => {
      if (r?.notifyBefore != null && r.notifyBefore !== prefs.get('notifyBefore', 60)) {
        prefs.set('notifyBefore', r.notifyBefore);
        const el = document.getElementById('pref-notify-before');
        if (el) el.value = String(r.notifyBefore);
      }
    }).catch(() => {});

    pruneOldCompleted();   // housekeeping; deliberately not awaited
  } catch (err) {
    toast(`Failed to load data: ${err.message}`, 'error');
    console.error(err);
    document.getElementById('classes-container').innerHTML = `
      <div style="padding:32px;text-align:center;color:#ef4444;">
        <strong>Could not load your data.</strong><br>
        <span style="font-size:0.85rem;color:#64748b;">${err.message}</span><br><br>
        <button class="btn btn-secondary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

/* =============================================================================
   PRUNE OLD COMPLETED ASSIGNMENTS
   A scheduled Cloud Function used to delete completed assignments 30 days after
   completion. It died with the move to the Spark plan, so they accumulated
   invisibly — hidden from the board, but still real documents that showed up in
   the "this will also delete N assignments" count. This restores that policy on
   the client. It runs against already-loaded state, so it costs no extra reads.
   ============================================================================= */
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneOldCompleted() {
  const done = state.homework.filter(h => h.completed);
  if (!done.length) return;

  const cutoff = Date.now() - COMPLETED_TTL_MS;
  const stale  = done.filter(h => h.completedAt?.seconds && h.completedAt.seconds * 1000 <= cutoff);
  // Assignments completed before completedAt was recorded have no age, so they
  // would never expire. Stamp them instead of guessing: they age out 30 days
  // from now rather than being deleted on a date we can't actually establish.
  const undated = done.filter(h => !h.completedAt?.seconds);

  try {
    if (undated.length) {
      await Promise.all(undated.map(h => api.homework.update(h.id, { completed: true })));
    }
    if (!stale.length) return;

    // Completing an assignment already clears its attachments, but documents
    // predating that behaviour may still be holding files in Storage.
    await Promise.all(stale.filter(h => h.attachments?.length)
                           .map(h => deleteAttachments(h.attachments)));
    await batchDelete(stale.map(h => userCol('homework').doc(h.id)));

    const gone = new Set(stale.map(h => h.id));
    state.homework = state.homework.filter(h => !gone.has(h.id));
    renderSummary();
    toast(`Cleaned up ${stale.length} completed assignment${stale.length === 1 ? '' : 's'} older than 30 days`, 'info');
  } catch (err) {
    // Never block startup over housekeeping — it'll try again next load
    console.warn('Prune of old completed assignments failed:', err);
  }
}

/* =============================================================================
   REFRESH ON FOCUS
   Nothing here uses snapshot listeners — every read is a one-shot get() — so an
   edit made on another device stays invisible until we re-read. That's not just
   a display problem: a stale list gets written back wholesale by the next
   drag-to-reorder, silently undoing the other device's work. Re-reading when the
   tab regains focus covers the realistic case (phone, then back to the laptop).
   ============================================================================= */
// Each refresh re-reads every doc, and Spark allows 50k reads/day, so rate-limit
// it. A minute is plenty — nobody switches phone → laptop faster than that.
const REFRESH_MIN_GAP_MS = 60_000;
let _lastRefresh = 0;
let _refreshing  = false;

async function refreshFromServer() {
  if (_refreshing || !auth.currentUser || !_appBooted) return;
  if (Date.now() - _lastRefresh < REFRESH_MIN_GAP_MS) return;
  // Never yank the data out from under an in-flight drag or a half-filled form
  if (document.body.classList.contains('is-dragging')) return;
  if (document.querySelector('.modal--open')) return;

  _refreshing = true;
  try {
    const [tabs, classes, folders, homework] = await Promise.all([
      api.tabs.list(), api.classes.list(), api.folders.list(), api.homework.list()
    ]);
    _lastRefresh   = Date.now();
    state.tabs     = tabs;
    state.classes  = classes;
    state.folders  = folders;
    state.homework = homework;
    resortClasses();
    if (!state.activeTabId || !tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();
  } catch (err) {
    // Stay quiet: this is background work and the stale view still functions
    console.warn('Background refresh failed:', err);
  } finally {
    _refreshing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromServer();
});
window.addEventListener('focus', refreshFromServer);

/* =============================================================================
   AUTH GATE — wait for Firebase to restore session before doing anything
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  const authScreen  = document.getElementById('auth-screen');
  const authLoading = document.getElementById('auth-loading');
  const authCard    = document.getElementById('auth-card');
  const appWrapper  = document.getElementById('app-wrapper');

  const PERSONAL_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com','live.com','msn.com','aol.com','protonmail.com']);
  const isOrgEmail = email => !PERSONAL_DOMAINS.has(email.split('@')[1]?.toLowerCase());

  // Email / password auth
  let authMode = 'signin'; // 'signin' | 'signup'

  function friendlyAuthError(code) {
    switch (code) {
      case 'auth/invalid-email':        return 'Invalid email address.';
      case 'auth/user-not-found':       return 'No account with that email.';
      case 'auth/wrong-password':       return 'Incorrect password.';
      case 'auth/email-already-in-use': return 'An account with that email already exists.';
      case 'auth/weak-password':        return 'Password must be at least 6 characters.';
      case 'auth/too-many-requests':    return 'Too many attempts. Try again later.';
      case 'auth/invalid-credential':   return 'Incorrect email or password.';
      default:                          return 'Something went wrong. Please try again.';
    }
  }

  function showAuthError(elId, msg) {
    const el = document.getElementById(elId);
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else     { el.textContent = ''; el.classList.add('hidden'); }
  }

  function showAuthPanel(panel) {
    document.getElementById('auth-panel-main').classList.toggle('hidden', panel !== 'main');
    document.getElementById('auth-panel-forgot').classList.toggle('hidden', panel !== 'forgot');
  }

  // Sign in / sign up toggle
  document.getElementById('auth-toggle').addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    const isSignup = authMode === 'signup';
    document.getElementById('email-auth-submit').textContent = isSignup ? 'Create Account' : 'Sign In';
    document.getElementById('auth-toggle').textContent = isSignup ? 'Sign in' : 'Sign up';
    document.getElementById('auth-forgot').classList.toggle('hidden', isSignup);
    showAuthError('auth-error', '');
  });

  // Email / password submit
  document.getElementById('email-auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const btn      = document.getElementById('email-auth-submit');
    showAuthError('auth-error', '');
    btn.disabled = true;
    try {
      if (authMode === 'signup') {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        if (!isOrgEmail(email)) await cred.user.sendEmailVerification();
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }
    } catch (err) {
      showAuthError('auth-error', friendlyAuthError(err.code));
    } finally {
      btn.disabled = false;
    }
  });

  // Forgot password — show dedicated panel
  document.getElementById('auth-forgot').addEventListener('click', () => {
    const prefill = document.getElementById('auth-email').value.trim();
    document.getElementById('auth-reset-email').value = prefill;
    showAuthError('auth-reset-error', '');
    showAuthPanel('forgot');
  });

  document.getElementById('auth-back').addEventListener('click', () => {
    showAuthPanel('main');
  });

  document.getElementById('auth-reset-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-reset-email').value.trim();
    const btn   = document.getElementById('auth-reset-submit');
    if (!email) { showAuthError('auth-reset-error', 'Enter your email address.'); return; }
    showAuthError('auth-reset-error', '');
    btn.disabled = true;
    try {
      await auth.sendPasswordResetEmail(email);
      toast('Password reset email sent — check your inbox.', 'success');
      showAuthPanel('main');
    } catch (err) {
      showAuthError('auth-reset-error', friendlyAuthError(err.code));
    } finally {
      btn.disabled = false;
    }
  });

  // Verification screen actions
  document.getElementById('auth-resend-btn').addEventListener('click', async () => {
    const btn = document.getElementById('auth-resend-btn');
    btn.disabled = true;
    try {
      await auth.currentUser.sendEmailVerification();
      toast('Verification email resent — check your inbox.', 'success');
    } catch { toast('Could not resend. Try again shortly.', 'error'); }
    finally { btn.disabled = false; }
  });
  document.getElementById('auth-verify-signout').addEventListener('click', () => auth.signOut());

  // Google sign-in
  document.getElementById('google-signin-btn').addEventListener('click', () => {
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => {
      toast(`Sign-in failed: ${err.message}`, 'error');
    });
  });


  // Firebase resolves auth state from cache — this fires in ~100ms for returning users
  auth.onAuthStateChanged(user => {
    currentUser = user;
    const verifyEl = document.getElementById('auth-verify');
    if (user && !user.emailVerified && user.providerData[0]?.providerId === 'password' && !isOrgEmail(user.email)) {
      // Email/password user who hasn't verified yet — show verification screen
      document.getElementById('auth-verify-email').textContent = user.email;
      authScreen.classList.remove('hidden');
      appWrapper.classList.add('hidden');
      document.getElementById('auth-loading').classList.add('hidden');
      document.getElementById('auth-card').classList.add('hidden');
      verifyEl.classList.remove('hidden');
      return;
    }
    verifyEl.classList.add('hidden');
    if (user) {
      // Close any lingering modals before showing the app
      document.getElementById('settings-modal').classList.remove('modal--open');
      document.getElementById('hw-modal').classList.remove('modal--open');

      // Show app, hide auth screen
      authScreen.classList.add('hidden');
      appWrapper.classList.remove('hidden');

      // Re-apply prefs (theme/accent) every login — needed after logout clears data-theme
      applyPrefs();

      // Show avatar in header
      const avatar = document.getElementById('user-avatar');
      if (user.photoURL) { avatar.src = user.photoURL; avatar.alt = user.displayName || ''; }

      // Load data and boot app
      init();
    } else {
      // Reset theme so auth screen is always light/readable
      document.documentElement.removeAttribute('data-theme');

      // Show sign-in card, hide spinner
      appWrapper.classList.add('hidden');
      authScreen.classList.remove('hidden');
      authLoading.classList.add('hidden');
      authCard.classList.remove('hidden');
    }
  });
});