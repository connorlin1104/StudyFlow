/* =============================================================================
   FIREBASE IMPORTS & INIT
   ============================================================================= */
import { initializeApp }                                from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup,
         onAuthStateChanged, signOut }                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, doc, getDocs,
         addDoc, getDoc, updateDoc, deleteDoc,
         setDoc, writeBatch, serverTimestamp,
         deleteField }                                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase config — the API key is safe to expose; security is enforced by Firestore Rules
const firebaseConfig = {
  apiKey:            'AIzaSyDkysaVPbRhebH6UWcrgwSCZKAiUWdUSKU',
  authDomain:        'studyflow-38a6b.firebaseapp.com',
  projectId:         'studyflow-38a6b',
  storageBucket:     'studyflow-38a6b.firebasestorage.app',
  messagingSenderId: '1095751201974',
  appId:             '1:1095751201974:web:47146e2ca008eeeeee6217'
};

const firebaseApp     = initializeApp(firebaseConfig);
const auth            = getAuth(firebaseApp);
const db              = getFirestore(firebaseApp);
const googleProvider  = new GoogleAuthProvider();

let currentUser = null;

// Firestore path helpers
const userCol = col      => collection(db, 'users', currentUser.uid, col);
const userDoc = (col,id) => doc(db,       'users', currentUser.uid, col, id);

/* =============================================================================
   API LAYER — Firestore
   ============================================================================= */
const api = {
  tabs: {
    async list() {
      const snap = await getDocs(userCol('tabs'));
      const tabs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // createdAt may be a Firestore Timestamp (has .seconds) or an ISO string (migrated data)
      tabs.sort((a, b) => {
        const ts = v => v?.seconds ?? (v ? new Date(v).getTime() / 1000 : 0);
        return ts(a.createdAt) - ts(b.createdAt);
      });
      return tabs;
    },
    async create(body) {
      const ref = await addDoc(userCol('tabs'), { ...body, createdAt: serverTimestamp() });
      return { id: ref.id, ...body };
    },
    async update(id, body) {
      await updateDoc(userDoc('tabs', id), body);
      return { id, ...body };
    },
    async remove(id) {
      const clsInTab = state.classes.filter(c => c.tabId === id);
      const clsIds   = new Set(clsInTab.map(c => c.id));
      const hwInTab  = state.homework.filter(h => clsIds.has(h.classId));
      const batch    = writeBatch(db);
      batch.delete(userDoc('tabs', id));
      clsInTab.forEach(c => batch.delete(userDoc('classes',  c.id)));
      hwInTab.forEach( h => batch.delete(userDoc('homework', h.id)));
      await batch.commit();
      return { ok: true };
    }
  },

  classes: {
    async list() {
      const snap    = await getDocs(userCol('classes'));
      const classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      classes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return classes;
    },
    async create(body) {
      const order = Date.now();
      const ref   = await addDoc(userCol('classes'), { ...body, order, createdAt: serverTimestamp() });
      return { id: ref.id, ...body, order };
    },
    async update(id, body) {
      await updateDoc(userDoc('classes', id), body);
      const snap = await getDoc(userDoc('classes', id));
      return { id: snap.id, ...snap.data() };
    },
    async remove(id) {
      const hwToDelete = state.homework.filter(h => h.classId === id);
      const batch      = writeBatch(db);
      batch.delete(userDoc('classes', id));
      hwToDelete.forEach(h => batch.delete(userDoc('homework', h.id)));
      await batch.commit();
      return { ok: true };
    },
    async reorder(orderedIds) {
      const batch = writeBatch(db);
      orderedIds.forEach((id, index) => batch.update(userDoc('classes', id), { order: index }));
      await batch.commit();
      return { ok: true };
    }
  },

  homework: {
    async list() {
      const snap = await getDocs(userCol('homework'));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async create(body) {
      const ref = await addDoc(userCol('homework'), { ...body, completed: false, createdAt: serverTimestamp() });
      return { id: ref.id, ...body, completed: false };
    },
    async update(id, body) {
      await updateDoc(userDoc('homework', id), body);
      const snap = await getDoc(userDoc('homework', id));
      return { id: snap.id, ...snap.data() };
    },
    async remove(id) {
      await deleteDoc(userDoc('homework', id));
      return { ok: true };
    }
  }
};

/* =============================================================================
   STATE
   ============================================================================= */
const state = {
  tabs:        [],
  activeTabId: null,
  classes:     [],
  homework:    []
};

/* =============================================================================
   UNDO / REDO HISTORY (max 30 entries)
   ============================================================================= */
const history = {
  past:   [],
  future: [],
  push(action) {
    this.past.push(action);
    if (this.past.length > 30) this.past.shift();
    this.future = [];
    updateHistoryBtns();
  },
  async undo() {
    if (!this.past.length) return;
    const action = this.past.pop();
    try { await action.undo(); } catch (err) { toast(`Undo failed: ${err.message}`, 'error'); }
    this.future.push(action);
    updateHistoryBtns();
  },
  async redo() {
    if (!this.future.length) return;
    const action = this.future.pop();
    try { await action.redo(); } catch (err) { toast(`Redo failed: ${err.message}`, 'error'); }
    this.past.push(action);
    updateHistoryBtns();
  }
};

function updateHistoryBtns() {
  document.getElementById('undo-btn').disabled = history.past.length === 0;
  document.getElementById('redo-btn').disabled = history.future.length === 0;
}

/* =============================================================================
   CONSTANTS
   ============================================================================= */
const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
];

let _draggedClassId = null;

function getNextAvailableColor(tabId) {
  const used = new Set(state.classes.filter(c => c.tabId === tabId).map(c => c.color));
  return PRESET_COLORS.find(c => !used.has(c)) ?? PRESET_COLORS[0];
}

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
    if (r===1) return `${n}st`; if (r===2) return `${n}nd`; if (r===3) return `${n}rd`;
    return `${n}th`;
  }
  const stripped  = s.replace(/^\bperiod\b\s*/i,'').replace(/\s*\bperiod\b$/i,'').trim();
  const numMatch  = stripped.match(/^(\d+)(st|nd|rd|th)?$/i);
  if (numMatch) { const n = parseInt(numMatch[1],10); if (n>=1&&n<=20) return `${ordinal(n)} Period`; }
  const lower = stripped.toLowerCase();
  if (WORD_MAP[lower] !== undefined) return `${ordinal(WORD_MAP[lower])} Period`;
  return s;
}

function parseDeadline(dateStr) {
  if (!dateStr) return null;
  const due   = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff  = Math.floor((due-today)/86_400_000);
  const label = due.toLocaleDateString('en-US', {
    month:'short', day:'numeric',
    ...(due.getFullYear()!==today.getFullYear() && {year:'numeric'})
  });
  return { label: `Due ${label}`, diff };
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
   AUTH
   ============================================================================= */
function showAuthScreen() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-wrapper').classList.remove('hidden');
}

async function handleGoogleSignIn() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      toast(`Sign in failed: ${err.message}`, 'error');
    }
  }
}

async function handleSignOut() {
  try {
    state.tabs = []; state.classes = []; state.homework = [];
    state.activeTabId = null;
    history.past = []; history.future = [];
    updateHistoryBtns();
    await signOut(auth);
  } catch (err) { toast(`Sign out failed: ${err.message}`, 'error'); }
}

async function loadUserData() {
  try {
    const [tabs, classes, homework] = await Promise.all([
      api.tabs.list(), api.classes.list(), api.homework.list()
    ]);
    state.tabs     = tabs;
    state.classes  = classes;
    state.homework = homework;
    state.activeTabId = tabs.length > 0 ? tabs[0].id : null;
    renderTabBar(); renderSchedule(); renderSummary();
  } catch (err) {
    console.error('loadUserData failed:', err);
    // Show a persistent banner so the user knows something is wrong
    const container = document.getElementById('classes-container');
    const emptyState = document.getElementById('empty-state');
    emptyState.classList.add('hidden');
    container.innerHTML = `
      <div style="padding:32px;text-align:center;color:#ef4444;">
        <strong>Could not load your data.</strong><br>
        <span style="font-size:0.85rem;color:#64748b;">${err.message}</span><br><br>
        <button class="btn btn-secondary" onclick="location.reload()">Retry</button>
      </div>`;
  }
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
    btn.textContent = tab.name;
    btn.addEventListener('click', () => setActiveTab(tab.id));
    list.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'tab tab--add';
  addBtn.title = 'Add or manage tabs';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', openSettings);
  list.appendChild(addBtn);
}

function setActiveTab(tabId) {
  state.activeTabId = tabId;
  renderTabBar(); renderSchedule();
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
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  container.innerHTML = '';
  tabClasses.forEach(cls => {
    const pending = state.homework
      .filter(h => h.classId===cls.id && !h.completed)
      .sort((a,b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1; if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      });
    container.appendChild(buildClassRow(cls, pending));
  });
}

function buildClassRow(cls, pendingHw) {
  const row = document.createElement('div');
  row.className = 'class-row';
  row.dataset.classId = cls.id;
  row.style.setProperty('--color', cls.color || '#94a3b8');

  const details  = [cls.teacher, cls.room, cls.period].filter(Boolean).join(' · ');
  const badgeHtml = pendingHw.length > 0
    ? `<span class="badge badge--pending">${pendingHw.length} pending</span>`
    : `<span class="badge badge--done">All done ✓</span>`;

  row.innerHTML = `
    <div class="class-header">
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

  const hwList = row.querySelector('.hw-list');
  if (pendingHw.length === 0) {
    hwList.innerHTML = `<div class="hw-empty">No pending assignments ✓</div>`;
  } else {
    pendingHw.forEach(hw => hwList.appendChild(buildHwItem(hw)));
  }
  return row;
}

function buildHwItem(hw) {
  const item = document.createElement('div');
  item.className = 'hw-item';
  item.dataset.hwId = hw.id;

  const dl     = parseDeadline(hw.deadline);
  const dlHtml = dl
    ? `<span class="deadline-badge ${deadlineCssClass(dl.diff)}">${esc(dl.label)}</span>`
    : '';
  const notesHtml = hw.notes ? `<span class="hw-notes">${esc(hw.notes)}</span>` : '';

  item.innerHTML = `
    <label class="hw-check-label" title="Mark complete">
      <input type="checkbox" class="hw-check" data-hw-id="${hw.id}">
      <span class="custom-check"></span>
    </label>
    <div class="hw-body">
      <span class="hw-desc">${esc(hw.description)}</span>
      ${notesHtml}
    </div>
    <div class="hw-right">
      ${dlHtml}
      <button class="btn-icon-sm hw-edit-btn" data-hw-id="${hw.id}" aria-label="Edit">✎</button>
      <button class="btn-icon-sm hw-delete"   data-hw-id="${hw.id}" aria-label="Delete">&#x2715;</button>
    </div>
  `;
  return item;
}

/* =============================================================================
   RENDER — SUMMARY PANEL
   ============================================================================= */
function renderSummary() {
  const list       = document.getElementById('summary-list');
  const empty      = document.getElementById('summary-empty');
  const countBadge = document.getElementById('summary-count');

  const pending = state.homework
    .filter(h => !h.completed)
    .sort((a,b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1; if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

  countBadge.textContent = pending.length;
  countBadge.classList.toggle('hidden', pending.length === 0);

  if (pending.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = '';

  pending.forEach(hw => {
    const cls = state.classes.find(c => c.id === hw.classId);
    if (!cls) return;
    const tab  = state.tabs.find(t => t.id === cls.tabId);
    const dl   = parseDeadline(hw.deadline);
    const item = document.createElement('div');
    item.className = 'summary-item';
    item.style.setProperty('--color', cls.color || '#94a3b8');
    const metaParts = [cls.name];
    if (tab && tab.id !== 'classes') metaParts.push(tab.name);
    item.innerHTML = `
      <div class="summary-color-bar"></div>
      <div class="summary-body">
        <span class="summary-desc">${esc(hw.description)}</span>
        <span class="summary-meta">${esc(metaParts.join(' · '))}</span>
      </div>
      ${dl
        ? `<span class="deadline-badge ${deadlineCssClass(dl.diff)}">${esc(dl.label)}</span>`
        : `<span class="deadline-badge deadline--ok">No date</span>`}
    `;
    list.appendChild(item);
  });
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
    item.innerHTML = `
      <span class="settings-tab-name">${esc(tab.name)}</span>
      <div class="settings-tab-actions">
        <button class="btn btn-sm btn-secondary edit-tab-btn" data-tab-id="${tab.id}">Edit</button>
        <button class="btn btn-sm btn-danger delete-tab-btn" data-tab-id="${tab.id}">Delete</button>
      </div>
    `;
    list.appendChild(item);
  });
}

/* =============================================================================
   RENDER — SETTINGS CLASS LIST (drag-to-reorder)
   ============================================================================= */
function renderSettingsClassList() {
  const tabId   = document.getElementById('settings-tab-select').value || state.activeTabId;
  const list    = document.getElementById('settings-classes-list');
  const classes = state.classes.filter(c => c.tabId === tabId);

  if (classes.length === 0) {
    list.innerHTML = '<p class="settings-empty">No groups in this tab yet.</p>';
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

      state.classes = [...state.classes.filter(c => c.tabId !== tabId), ...tabClasses];
      try {
        await api.classes.reorder(tabClasses.map(c => c.id));
        renderSettingsClassList(); renderSchedule();
      } catch (err) { toast(`Reorder failed: ${err.message}`, 'error'); }
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
function openHwModal(preselectedClassId = null) {
  if (state.classes.length === 0) { toast('Add some groups first in Settings.', 'warning'); return; }
  document.getElementById('hw-form').reset();
  document.getElementById('hw-edit-id').value = '';
  document.getElementById('hw-modal-title').textContent = 'New Assignment';
  document.getElementById('hw-form-submit').textContent = 'Add to Schedule';

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
  openHwModal(hw.classId);
  document.getElementById('hw-edit-id').value             = hw.id;
  document.getElementById('hw-desc').value                = hw.description || '';
  document.getElementById('hw-notes').value               = hw.notes       || '';
  document.getElementById('hw-deadline').value            = hw.deadline    || '';
  document.getElementById('hw-modal-title').textContent   = 'Edit Assignment';
  document.getElementById('hw-form-submit').textContent   = 'Save Changes';
}

function closeHwModal() { document.getElementById('hw-modal').classList.remove('modal--open'); }

/* =============================================================================
   SETTINGS MODAL
   ============================================================================= */
function openSettings() {
  populateSettingsTabSelect(state.activeTabId);
  resetClassForm();
  renderSettingsTabsList();
  renderSettingsClassList();
  switchSettingsPage('classes');
  document.getElementById('settings-modal').classList.add('modal--open');
}
function closeSettings() { document.getElementById('settings-modal').classList.remove('modal--open'); }

function populateSettingsTabSelect(selectValue) {
  const sel = document.getElementById('settings-tab-select');
  sel.innerHTML = state.tabs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = selectValue || state.activeTabId;
}

function switchSettingsPage(page) {
  ['tabs', 'classes', 'help'].forEach(p => {
    document.getElementById(`settings-page-${p}`).classList.toggle('hidden', page !== p);
  });
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('settings-nav--active', btn.dataset.page === page);
  });
  if (page === 'classes') updateSettingsLabels();
}

function updateSettingsLabels() {
  const tabId  = document.getElementById('settings-tab-select')?.value || state.activeTabId;
  const tab    = state.tabs.find(t => t.id === tabId);
  const name   = tab ? tab.name : 'Group';
  const editId = document.getElementById('edit-class-id').value;
  if (!editId) {
    const singular = singularize(name);
    document.getElementById('group-form-title').textContent  = `Add New ${singular}`;
    document.getElementById('class-form-submit').textContent = `Add ${singular}`;
  }
}

function resetClassForm() {
  document.getElementById('class-form').reset();
  document.getElementById('edit-class-id').value = '';
  document.getElementById('cancel-edit-class').classList.add('hidden');
  const tabId = document.getElementById('settings-tab-select')?.value || state.activeTabId;
  selectSwatch(getNextAvailableColor(tabId));
  updateSettingsLabels();
}

function startEditClass(cls) {
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

function openGroupForm() {
  document.getElementById('group-form-modal').classList.add('modal--open');
  document.getElementById('class-name').focus();
}
function closeGroupForm() {
  document.getElementById('group-form-modal').classList.remove('modal--open');
  resetClassForm();
}

/* =============================================================================
   MIGRATION — import from local db.json
   ============================================================================= */
async function migrateLocalData() {
  const raw = document.getElementById('migration-json').value.trim();
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); }
  catch { toast('Invalid JSON — paste the full contents of db.json', 'error'); return; }

  try {
    const allTabs  = data.tabs     || [];
    const allCls   = data.classes  || [];
    const allHw    = data.homework || [];
    const ops = allTabs.length + allCls.length + allHw.length;
    if (ops === 0) { toast('Nothing found to import.', 'warning'); return; }

    // Firestore batches are limited to 500 ops — chunk if needed
    const MAX = 499;
    const allOps = [
      ...allTabs.map((t, _i) => ({ col: 'tabs',     id: t.id, fields: (({ id, ...f }) => f)(t) })),
      ...allCls.map((c,  i)  => ({ col: 'classes',  id: c.id, fields: (({ id, ...f }) => ({ ...f, order: i }))(c) })),
      ...allHw.map((h,  _i) => ({ col: 'homework',  id: h.id, fields: (({ id, ...f }) => f)(h) }))
    ];

    for (let start = 0; start < allOps.length; start += MAX) {
      const chunk = allOps.slice(start, start + MAX);
      const batch = writeBatch(db);
      chunk.forEach(({ col, id, fields }) => batch.set(userDoc(col, id), fields));
      await batch.commit();
    }

    document.getElementById('migration-json').value = '';
    toast(`Imported ${ops} records successfully!`, 'success');
    await loadUserData();
  } catch (err) {
    console.error('Migration failed:', err);
    alert(`Import failed: ${err.message}\n\nCheck the browser console (F12) for details.\nMake sure you have run "firebase deploy" to activate Firestore security rules.`);
  }
}

/* =============================================================================
   EVENT HANDLERS
   ============================================================================= */
async function handleAddHomework(e) {
  e.preventDefault();
  const editId      = document.getElementById('hw-edit-id').value;
  const classId     = document.getElementById('hw-class').value;
  const description = document.getElementById('hw-desc').value.trim();
  const notes       = document.getElementById('hw-notes').value.trim();
  const deadline    = document.getElementById('hw-deadline').value;
  if (!classId || !description) return;

  const payload = {
    classId, description,
    ...(notes    && { notes }),
    ...(deadline && { deadline })
  };

  try {
    if (editId) {
      const updated = await api.homework.update(editId, payload);
      const i = state.homework.findIndex(h => h.id === editId);
      if (i !== -1) state.homework[i] = { ...state.homework[i], ...updated };
      renderSchedule(); renderSummary(); closeHwModal();
      toast(`Updated "${description}"`, 'success');
    } else {
      const hw = await api.homework.create(payload);
      state.homework.push(hw);
      renderSchedule(); renderSummary(); closeHwModal();
      toast(`Added "${description}"`, 'success');
    }
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleClassFormSubmit(e) {
  e.preventDefault();
  const id      = document.getElementById('edit-class-id').value;
  const tabId   = document.getElementById('settings-tab-select').value || state.activeTabId;
  const teacher = document.getElementById('class-teacher').value.trim();
  const room    = document.getElementById('class-room').value.trim();
  const period  = normalizePeriod(document.getElementById('class-period').value) || '';

  const data = {
    tabId,
    name:  document.getElementById('class-name').value.trim(),
    color: document.getElementById('class-color').value,
  };
  if (!data.name) return;

  // Firestore can't store undefined. When editing, use deleteField() to clear
  // optional fields the user left blank; when creating, just omit them.
  if (id) {
    data.teacher = teacher || deleteField();
    data.room    = room    || deleteField();
    data.period  = period  || deleteField();
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
      toast(`Added "${data.name}"`, 'success');
    }
    closeGroupForm();
    renderSettingsClassList(); renderSchedule(); renderSummary();
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleAddTab(e) {
  e.preventDefault();
  const name = document.getElementById('tab-name').value.trim();
  if (!name) return;
  try {
    const tab = await api.tabs.create({ name });
    state.tabs.push(tab);
    document.getElementById('tab-name').value = '';
    renderTabBar(); renderSettingsTabsList();
    populateSettingsTabSelect(tab.id); renderSettingsClassList();
    toast(`Added tab "${name}"`, 'success');
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleDeleteTab(tabId) {
  const tab    = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const tabCls  = state.classes.filter(c => c.tabId === tabId);
  const hwCount = state.homework.filter(h => tabCls.some(c => c.id === h.classId)).length;
  let msg = `Delete tab "${tab.name}"?`;
  if (tabCls.length) msg += `\n\nThis will also delete ${tabCls.length} group(s) and ${hwCount} assignment(s).`;
  if (!confirm(msg)) return;

  try {
    await api.tabs.remove(tabId);
    const clsIds = tabCls.map(c => c.id);
    state.tabs     = state.tabs.filter(t => t.id !== tabId);
    state.classes  = state.classes.filter(c => c.tabId !== tabId);
    state.homework = state.homework.filter(h => !clsIds.includes(h.classId));
    if (state.activeTabId === tabId) {
      state.activeTabId = state.tabs.length > 0 ? state.tabs[0].id : null;
    }
    renderTabBar(); renderSchedule(); renderSummary();
    renderSettingsTabsList();
    populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
    toast(`Deleted tab "${tab.name}"`, 'info');

    const { id: _id, createdAt: _ca, ...tabFields } = tab;
    const clsSnapshots = tabCls.map(({ id: _i, tabId: _t, createdAt: _c, order: _o, ...f }) => f);

    history.push({
      async undo() {
        const restored = await api.tabs.create(tabFields);
        state.tabs.push(restored);
        const restoredCls = await Promise.all(clsSnapshots.map(f => api.classes.create({ ...f, tabId: restored.id })));
        state.classes.push(...restoredCls);
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(restored.id); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Restored tab "${tab.name}"`, 'success');
      },
      async redo() {
        const r = state.tabs.find(t => t.name === tab.name);
        if (!r) return;
        await api.tabs.remove(r.id);
        const rClsIds = state.classes.filter(c => c.tabId === r.id).map(c => c.id);
        state.tabs     = state.tabs.filter(t => t.id !== r.id);
        state.classes  = state.classes.filter(c => c.tabId !== r.id);
        state.homework = state.homework.filter(h => !rClsIds.includes(h.classId));
        if (state.activeTabId === r.id) {
          state.activeTabId = state.tabs.length > 0 ? state.tabs[0].id : null;
        }
        renderTabBar(); renderSchedule(); renderSummary();
        renderSettingsTabsList(); populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
        toast(`Deleted tab "${tab.name}"`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleMarkComplete(hwId) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;
  try {
    const updated = await api.homework.update(hwId, { completed: true });
    const i = state.homework.findIndex(h => h.id === hwId);
    if (i !== -1) state.homework[i] = { ...state.homework[i], ...updated };
    renderSchedule(); renderSummary();
    toast(`Completed "${hw.description}"`, 'success');

    history.push({
      _desc: hw.description,
      async undo() {
        const upd = await api.homework.update(hwId, { completed: false });
        const j = state.homework.findIndex(h => h.id === hwId);
        if (j !== -1) state.homework[j] = { ...state.homework[j], ...upd, completed: false };
        renderSchedule(); renderSummary();
        toast(`Restored "${this._desc}"`, 'info');
      },
      async redo() {
        const upd = await api.homework.update(hwId, { completed: true });
        const j = state.homework.findIndex(h => h.id === hwId);
        if (j !== -1) state.homework[j] = { ...state.homework[j], ...upd, completed: true };
        renderSchedule(); renderSummary();
        toast(`Completed "${this._desc}"`, 'success');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleDeleteHw(hwId) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;
  if (!confirm(`Delete "${hw.description}"?`)) return;

  try {
    await api.homework.remove(hwId);
    state.homework = state.homework.filter(h => h.id !== hwId);
    renderSchedule(); renderSummary();
    toast(`Deleted "${hw.description}"`, 'info');

    const { id: _id, createdAt: _ca, completed: _co, ...restoreFields } = hw;
    const action = {
      restoredId: null,
      async undo() {
        const restored = await api.homework.create(restoreFields);
        this.restoredId = restored.id;
        state.homework.push(restored);
        renderSchedule(); renderSummary();
        toast(`Restored "${hw.description}"`, 'success');
      },
      async redo() {
        if (!this.restoredId) return;
        await api.homework.remove(this.restoredId);
        state.homework = state.homework.filter(h => h.id !== this.restoredId);
        renderSchedule(); renderSummary();
        toast(`Deleted "${hw.description}"`, 'info');
      }
    };
    history.push(action);
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

async function handleDeleteClass(classId) {
  const cls   = state.classes.find(c => c.id === classId);
  if (!cls) return;
  const clsHw = state.homework.filter(h => h.classId === classId);
  const msg   = clsHw.length
    ? `Delete "${cls.name}" and its ${clsHw.length} assignment(s)?`
    : `Delete "${cls.name}"?`;
  if (!confirm(msg)) return;

  try {
    await api.classes.remove(classId);
    state.classes  = state.classes.filter(c => c.id !== classId);
    state.homework = state.homework.filter(h => h.classId !== classId);
    renderSettingsClassList(); renderSchedule(); renderSummary();
    toast(`Deleted group "${cls.name}"`, 'info');

    const { id: _id, createdAt: _ca, order: _o, ...clsFields } = cls;
    const hwSnaps = clsHw.map(({ id: _i, classId: _c, createdAt: _c2, completed: _co, ...f }) => f);
    const action  = {
      restoredClassId: null,
      async undo() {
        const restored = await api.classes.create(clsFields);
        this.restoredClassId = restored.id;
        state.classes.push(restored);
        const restoredHw = await Promise.all(hwSnaps.map(f => api.homework.create({ ...f, classId: restored.id })));
        state.homework.push(...restoredHw);
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(`Restored "${cls.name}"`, 'success');
      },
      async redo() {
        if (!this.restoredClassId) return;
        await api.classes.remove(this.restoredClassId);
        state.classes  = state.classes.filter(c => c.id !== this.restoredClassId);
        state.homework = state.homework.filter(h => h.classId !== this.restoredClassId);
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(`Deleted group "${cls.name}"`, 'info');
      }
    };
    history.push(action);
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* =============================================================================
   WIRE EVENTS
   ============================================================================= */
function wireEvents() {
  document.getElementById('add-hw-btn').addEventListener('click', () => openHwModal());
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('empty-settings-btn').addEventListener('click', openSettings);
  document.getElementById('undo-btn').addEventListener('click', () => history.undo());
  document.getElementById('redo-btn').addEventListener('click', () => history.redo());

  document.getElementById('hw-form').addEventListener('submit', handleAddHomework);
  document.getElementById('close-hw-modal').addEventListener('click', closeHwModal);
  document.getElementById('cancel-hw').addEventListener('click', closeHwModal);
  document.getElementById('hw-backdrop').addEventListener('click', closeHwModal);

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
      selectSwatch(getNextAvailableColor(document.getElementById('settings-tab-select').value || state.activeTabId));
    }
  });

  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsPage(btn.dataset.page));
  });

  document.getElementById('settings-tabs-list').addEventListener('click', e => {
    const deleteBtn = e.target.closest('.delete-tab-btn');
    const editBtn   = e.target.closest('.edit-tab-btn');
    if (deleteBtn) handleDeleteTab(deleteBtn.dataset.tabId);
    if (editBtn) {
      populateSettingsTabSelect(editBtn.dataset.tabId);
      resetClassForm(); renderSettingsClassList();
      switchSettingsPage('classes');
    }
  });

  document.getElementById('settings-classes-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('.edit-class-btn');
    const deleteBtn = e.target.closest('.delete-class-btn');
    if (editBtn)   { const cls = state.classes.find(c => c.id === editBtn.dataset.classId); if (cls) startEditClass(cls); }
    if (deleteBtn) { handleDeleteClass(deleteBtn.dataset.classId); }
  });

  document.getElementById('classes-container').addEventListener('change', e => {
    const cb = e.target.closest('.hw-check');
    if (cb) handleMarkComplete(cb.dataset.hwId);
  });
  document.getElementById('classes-container').addEventListener('click', e => {
    const editBtn = e.target.closest('.hw-edit-btn');
    const delBtn  = e.target.closest('.hw-delete');
    const addBtn  = e.target.closest('.class-add-hw-btn');
    if (editBtn) openHwEditModal(editBtn.dataset.hwId);
    if (delBtn)  handleDeleteHw(delBtn.dataset.hwId);
    if (addBtn)  openHwModal(addBtn.dataset.classId);
  });

  // Help modals
  function openModal(id)  { document.getElementById(id).classList.add('modal--open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('modal--open'); }
  document.getElementById('whats-new-btn').addEventListener('click',  () => openModal('whats-new-modal'));
  document.getElementById('privacy-btn').addEventListener('click',     () => openModal('privacy-modal'));
  document.getElementById('close-whats-new').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('close-privacy').addEventListener('click',   () => closeModal('privacy-modal'));
  document.getElementById('whats-new-backdrop').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('privacy-backdrop').addEventListener('click',   () => closeModal('privacy-modal'));

  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key==='z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
    if (mod && (e.key==='y' || (e.key==='z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
    if (e.key==='Escape') {
      closeHwModal(); closeSettings(); closeGroupForm();
      closeModal('whats-new-modal'); closeModal('privacy-modal');
    }
  });
}

/* =============================================================================
   INIT
   ============================================================================= */
async function init() {
  initColorSwatches();
  wireEvents();

  // Auth buttons
  document.getElementById('google-signin-btn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('migration-btn').addEventListener('click', migrateLocalData);

  // Firebase auth state drives everything
  onAuthStateChanged(auth, async user => {
    if (user) {
      currentUser = user;
      const avatar = document.getElementById('user-avatar');
      avatar.src   = user.photoURL || '';
      avatar.title = user.displayName || user.email;
      document.getElementById('user-name').textContent = user.displayName?.split(' ')[0] || '';
      showApp();
      await loadUserData();
    } else {
      currentUser = null;
      showAuthScreen();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
