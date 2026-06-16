'use strict';

/* =============================================================================
   FIREBASE AUTH — compat SDK (loaded via <script> tags)
   jkl2
   ============================================================================= */
firebase.initializeApp(window.FIREBASE_CONFIG);

const auth    = firebase.auth();
const storage = firebase.storage();
let currentUser = null;

let formAttachments = []; // { id, name, type, localUrl, url, storagePath, uploading, error }

/* =============================================================================
   API HELPER — sends Firebase ID token with every request
   ============================================================================= */
async function apiFetch(method, path, body) {
  const token = await auth.currentUser?.getIdToken();
  const res   = await fetch(path, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

/* =============================================================================
   API LAYER
   ============================================================================= */
const api = {
  tabs: {
    list()              { return apiFetch('GET',    '/api/tabs'); },
    create(body)        { return apiFetch('POST',   '/api/tabs', body); },
    update(id, body)    { return apiFetch('PUT',    `/api/tabs/${id}`, body); },
    remove(id)          { return apiFetch('DELETE', `/api/tabs/${id}`); },
    reorder(orderedIds) { return apiFetch('POST',   '/api/tabs/reorder', { order: orderedIds }); }
  },
  classes: {
    list()              { return apiFetch('GET',    '/api/classes'); },
    create(body)        { return apiFetch('POST',   '/api/classes', body); },
    update(id, body)    { return apiFetch('PUT',    `/api/classes/${id}`, body); },
    remove(id)          { return apiFetch('DELETE', `/api/classes/${id}`); },
    reorder(orderedIds) { return apiFetch('POST',   '/api/classes/reorder', { order: orderedIds }); }
  },
  homework: {
    list()              { return apiFetch('GET',    '/api/homework'); },
    create(body)        { return apiFetch('POST',   '/api/homework', body); },
    update(id, body)    { return apiFetch('PUT',    `/api/homework/${id}`, body); },
    remove(id)          { return apiFetch('DELETE', `/api/homework/${id}`); },
    reorder(orderedIds) { return apiFetch('POST',   '/api/homework/reorder', { order: orderedIds }); }
  }
};

/* =============================================================================
   STATE
   ============================================================================= */
const state = {
  tabs:        [],
  activeTabId: 'classes',
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
    return;
  }
  emptyState.classList.add('hidden');
  container.innerHTML = '';
  tabClasses.forEach(cls => {
    const groupHw = state.homework.filter(h => h.classId === cls.id && !h.completed);
    const hasManualOrder = groupHw.some(h => h.order != null);
    const pending = groupHw.sort((a, b) => {
      if (hasManualOrder) {
        if (a.order != null && b.order != null) return a.order - b.order;
        if (a.order != null) return -1;
        if (b.order != null) return 1;
      }
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline + (a.deadlineTime ? `T${a.deadlineTime}` : 'T23:59')) - new Date(b.deadline + (b.deadlineTime ? `T${b.deadlineTime}` : 'T23:59'));
    });
    container.appendChild(buildClassRow(cls, pending));
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
}

function buildClassRow(cls, pendingHw) {
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

  const hwList = row.querySelector('.hw-list');
  if (pendingHw.length === 0) {
    hwList.innerHTML = `<div class="hw-empty">No pending assignments ✓</div>`;
  } else {
    pendingHw.forEach(hw => {
      const item = buildHwItem(hw);
      addHwDragBehavior(item, hw, hwList);
      hwList.appendChild(item);
    });
  }
  return row;
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

function buildHwItem(hw) {
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
  return item;
}

function addHwDragBehavior(item, hw, hwList) {
  // Desktop: HTML5 drag-and-drop
  item.draggable = true;

  item.addEventListener('dragstart', e => {
    _draggedHwId = hw.id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => item.classList.add('hw-dragging'), 0);
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('hw-dragging');
    hwList.querySelectorAll('.hw-item').forEach(el => el.classList.remove('hw-drag-over'));
    _draggedHwId = null;
  });
  item.addEventListener('dragover', e => {
    e.preventDefault();
    if (_draggedHwId === hw.id) return;
    hwList.querySelectorAll('.hw-item').forEach(el => el.classList.remove('hw-drag-over'));
    item.classList.add('hw-drag-over');
  });
  item.addEventListener('dragleave', e => {
    if (!item.contains(e.relatedTarget)) item.classList.remove('hw-drag-over');
  });
  item.addEventListener('drop', async e => {
    e.preventDefault();
    item.classList.remove('hw-drag-over');
    if (!_draggedHwId || _draggedHwId === hw.id) return;
    await commitHwReorder(hwList, _draggedHwId, hw.id);
  });

  // Mobile: long-press touch drag
  let touchTimer = null;
  let touchActive = false;
  let touchClone = null;
  let touchOffX = 0, touchOffY = 0;

  item.addEventListener('touchstart', e => {
    const touch = e.touches[0];
    touchTimer = setTimeout(() => {
      touchActive = true;
      _draggedHwId = hw.id;
      item.classList.add('hw-dragging');
      if (navigator.vibrate) navigator.vibrate(50);
      const rect = item.getBoundingClientRect();
      touchOffX = touch.clientX - rect.left;
      touchOffY = touch.clientY - rect.top;
      touchClone = item.cloneNode(true);
      touchClone.className = 'hw-item hw-drag-clone';
      touchClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:9999;pointer-events:none;opacity:.85;box-shadow:0 8px 24px rgba(0,0,0,.18);border-radius:8px;`;
      document.body.appendChild(touchClone);
    }, 300);
  }, { passive: true });

  item.addEventListener('touchmove', e => {
    if (!touchActive) { clearTimeout(touchTimer); return; }
    e.preventDefault();
    const touch = e.touches[0];
    if (touchClone) {
      touchClone.style.left = `${touch.clientX - touchOffX}px`;
      touchClone.style.top  = `${touch.clientY - touchOffY}px`;
      touchClone.style.visibility = 'hidden';
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      touchClone.style.visibility = '';
      const targetItem = el?.closest?.('.hw-item');
      hwList.querySelectorAll('.hw-item').forEach(el => el.classList.remove('hw-drag-over'));
      if (targetItem && targetItem !== item && hwList.contains(targetItem)) {
        targetItem.classList.add('hw-drag-over');
      }
    }
  }, { passive: false });

  const endTouch = async () => {
    clearTimeout(touchTimer);
    if (touchClone) { touchClone.remove(); touchClone = null; }
    item.classList.remove('hw-dragging');
    if (!touchActive) { touchActive = false; return; }
    touchActive = false;
    const dropTarget = hwList.querySelector('.hw-item.hw-drag-over');
    hwList.querySelectorAll('.hw-item').forEach(el => el.classList.remove('hw-drag-over'));
    if (dropTarget && _draggedHwId) {
      const targetHwId = dropTarget.dataset.hwId;
      if (targetHwId !== _draggedHwId) await commitHwReorder(hwList, _draggedHwId, targetHwId);
    }
    _draggedHwId = null;
  };

  item.addEventListener('touchend',    endTouch, { passive: true });
  item.addEventListener('touchcancel', endTouch, { passive: true });
}

async function commitHwReorder(hwList, fromId, toId) {
  const items   = [...hwList.querySelectorAll('.hw-item')];
  const ids     = items.map(el => el.dataset.hwId);
  const fromIdx = ids.indexOf(fromId);
  const toIdx   = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return;

  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, fromId);

  ids.forEach((id, i) => {
    const hw = state.homework.find(h => h.id === id);
    if (hw) hw.order = i;
  });

  const classId = state.homework.find(h => h.id === fromId)?.classId;
  if (classId) {
    const pending = state.homework
      .filter(h => h.classId === classId && !h.completed)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    hwList.innerHTML = '';
    pending.forEach(hw => {
      const newItem = buildHwItem(hw);
      addHwDragBehavior(newItem, hw, hwList);
      hwList.appendChild(newItem);
    });
  }

  _draggedHwId = null;

  try {
    await api.homework.reorder(ids);
  } catch (err) {
    toast(`Reorder failed: ${err.message}`, 'error');
  }
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

      state.tabs = tabs;
      try {
        await api.tabs.reorder(tabs.map(t => t.id));
        renderSettingsTabsList();
        renderTabBar();
      } catch (err) {
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

      state.classes = [...state.classes.filter(c => c.tabId !== tabId), ...tabClasses];
      try {
        await api.classes.reorder(tabClasses.map(c => c.id));
        renderSettingsClassList();
        renderSchedule();
      } catch (err) {
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
function openHwModal(preselectedClassId = null) {
  if (state.classes.length === 0) {
    toast('Add some topics first in Settings.', 'warning');
    return;
  }
  document.getElementById('hw-form').reset();
  document.getElementById('hw-reminder').value = '';
  document.getElementById('hw-edit-id').value = '';
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
  reminderSel.value = (hw.remindBefore != null && hw.remindBefore !== 0) ? String(hw.remindBefore) : '';
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
  document.getElementById('edit-class-id').value           = cls.id;
  document.getElementById('class-name').value              = cls.name    || '';
  document.getElementById('class-teacher').value           = cls.teacher || '';
  document.getElementById('class-room').value              = cls.room    || '';
  document.getElementById('class-period').value            = cls.period  || '';
  document.getElementById('group-form-title').textContent  = 'Edit Topic';
  document.getElementById('class-form-submit').textContent = 'Save Changes';
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

  const reminderVal = document.getElementById('hw-reminder').value;
  const remindBefore = deadline && reminderVal !== '' ? parseInt(reminderVal) : null;

  let deadlineMs = null;
  if (deadline) {
    const timeStr = deadlineTime || '00:00';
    deadlineMs = new Date(`${deadline}T${timeStr}:00`).getTime();
  }

  const attachments = formAttachments
    .filter(a => a.url && !a.error)
    .map(({ name, type, url, storagePath }) => ({ name, type, url, storagePath }));
  const payload = {
    classId, description,
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

async function handleDeleteHw(hwId) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;
  if (!await showConfirm({ title: `Delete "${hw.description}"?`, confirmText: 'Delete', icon: '🗑️' })) return;

  try {
    await api.homework.remove(hwId);
    state.homework = state.homework.filter(h => h.id !== hwId);
    renderSchedule();
    renderSummary();
    toast(`Deleted "${hw.description}"`, 'info');

    const { id: _id, createdAt: _ca, completed: _co, attachments: _att, ...restoreFields } = hw;
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
  const clsSubMsg = clsHw.length
    ? `This will also delete ${clsHw.length} assignment${clsHw.length !== 1 ? 's' : ''}.`
    : '';
  if (!await showConfirm({ title: `Delete "${cls.name}"?`, message: clsSubMsg, confirmText: 'Delete Topic', icon: '🗑️' })) return;

  try {
    await api.classes.remove(classId);
    state.classes  = state.classes.filter(c => c.id !== classId);
    state.homework = state.homework.filter(h => h.classId !== classId);
    renderSettingsClassList(); renderSchedule(); renderSummary();
    const clsLabel = tabItemLabel(cls.tabId);
    toast(`Deleted ${clsLabel} "${cls.name}"`, 'info');

    const { id: _id, createdAt: _ca, ...clsFields } = cls;
    const hwSnaps = clsHw.map(({ id: _i, classId: _c, createdAt: _c2, completed: _co, ...f }) => f);
    const action = {
      restoredClassId: null,
      async undo() {
        const restored = await api.classes.create(clsFields);
        this.restoredClassId = restored.id;
        state.classes.push(restored);
        const restoredHw = await Promise.all(hwSnaps.map(f => api.homework.create({ ...f, classId: restored.id })));
        state.homework.push(...restoredHw);
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(`Restored ${clsLabel} "${cls.name}"`, 'success');
      },
      async redo() {
        if (!this.restoredClassId) return;
        await api.classes.remove(this.restoredClassId);
        state.classes  = state.classes.filter(c => c.id !== this.restoredClassId);
        state.homework = state.homework.filter(h => h.classId !== this.restoredClassId);
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(`Deleted ${clsLabel} "${cls.name}"`, 'info');
      }
    };
    history.push(action);
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
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
    await Promise.all(state.classes.map(c => api.classes.remove(c.id)));
    await Promise.all(state.tabs.map(t => api.tabs.remove(t.id)));

    state.tabs     = [];
    state.classes  = [];
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

    for (const h of (data.homework || [])) {
      const { _origId, classId, ...body } = h;
      const newClassId = clsIdMap[classId];
      if (!newClassId) continue;
      const created = await api.homework.create({ ...body, classId: newClassId });
      state.homework.push(created);
    }

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
   ============================================================================= */
const VAPID_PUBLIC_KEY = 'BOrVSBk5blypBLGFYLnlfvkwSX9dxCtvSNISDJIDY89sy2q7mCudoX3WLA94yEp0m-L0ICpnxrk0guyYc2NLld0';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
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
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    const notifyBefore = prefs.get('notifyBefore', 60);
    await apiFetch('POST', '/api/notifications/subscribe', {
      subscription:  sub.toJSON(),
      notifyBefore
    });
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
      await apiFetch('DELETE', '/api/notifications/subscribe', { endpoint });
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
    try { await apiFetch('PUT', '/api/notifications/prefs', { notifyBefore: val }); }
    catch (_) {}
  });
  // TEST BUTTON — uncomment to re-enable
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

      async function commitRename() {
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

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') renderSettingsTabsList();
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
  document.getElementById('classes-container').addEventListener('click', e => {
    const editBtn  = e.target.closest('.hw-edit-btn');
    const delBtn   = e.target.closest('.hw-delete');
    const addBtn   = e.target.closest('.class-add-hw-btn');
    if (editBtn) { openHwEditModal(editBtn.dataset.hwId); return; }
    if (delBtn)  { handleDeleteHw(delBtn.dataset.hwId);   return; }
    if (addBtn)  { openHwModal(addBtn.dataset.classId);   return; }

    // Attachment image → lightbox
    const attachImg = e.target.closest('.hw-attach-img');
    if (attachImg) { openLightbox(attachImg.dataset.lightbox); return; }

    // Toggle topic collapse (click anywhere on header except + Add)
    const header = e.target.closest('.class-header');
    if (header) {
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
    if (mod && e.key==='z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
    if (mod && (e.key==='y' || (e.key==='z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
    if (e.key==='Escape') {
      if (!document.getElementById('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
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
    const [tabs, classes, homework] = await Promise.all([
      api.tabs.list(),
      api.classes.list(),
      api.homework.list()
    ]);
    state.tabs     = tabs;
    state.classes  = classes;
    state.homework = homework;
    if (!state.activeTabId || !tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();

    // Sync notifyBefore from server so all devices share one preference
    apiFetch('GET', '/api/notifications/prefs').then(r => {
      if (r?.notifyBefore != null && r.notifyBefore !== prefs.get('notifyBefore', 60)) {
        prefs.set('notifyBefore', r.notifyBefore);
        const el = document.getElementById('pref-notify-before');
        if (el) el.value = String(r.notifyBefore);
      }
    }).catch(() => {});
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