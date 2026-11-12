import { FieldValue, auth, db, storage } from './firebase.js';

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
    async create({ classId, folderId, description, notes, deadline, deadlineTime, deadlineMs, remindBefore, priority, estimateMin, attachments, completed, completedAt, order }) {
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
      if (priority === 'high' || priority === 'low') data.priority = priority;
      if (estimateMin > 0) data.estimateMin = estimateMin;
      if (Array.isArray(attachments) && attachments.length) data.attachments = attachments;
      return readBack(await userCol('homework').add(data));
    },
    async update(id, { classId, folderId, description, notes, deadline, deadlineTime, deadlineMs, completed, remindBefore, priority, estimateMin, attachments }) {
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
      // null (or 'normal') clears it back to normal
      if (priority     !== undefined) update.priority     = priority === 'high' || priority === 'low' ? priority : null;
      if (estimateMin  !== undefined) update.estimateMin  = estimateMin > 0 ? estimateMin : null;
      if (attachments  !== undefined) update.attachments  = Array.isArray(attachments) ? attachments : [];
      // A cleared field arrives as null or '' but may be missing on the stored
      // document, so compare them as equals — otherwise every re-save of an
      // untimed assignment would reset remindedAt and send its reminder again.
      const same = (a, b) => (a || null) === (b || null);
      if ((deadline     !== undefined && !same(deadline,     existing.deadline)) ||
          (deadlineTime !== undefined && !same(deadlineTime, existing.deadlineTime))) {
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

export { api, batchDelete, deleteAttachments, userCol, writeOrders };
