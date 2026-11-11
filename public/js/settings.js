import { currentUser } from './firebase.js';
import { api } from './api.js';
import { state } from './state.js';
import { ACCENT_OPTIONS, applyPrefs, prefs } from './prefs.js';
import { PRESET_COLORS, getNextAvailableColor, singularize } from './constants.js';
import { esc, toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';

// Module-level drag state for settings reorder
let _draggedClassId = null;
let _draggedTabId   = null;
let _draggedHwId    = null;

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

export { closeGroupForm, closeSettings, initAccentSwatches, initColorSwatches, openGroupForm, openSettings, populateSettingsTabSelect, renderPrefsPage, renderSettingsClassList, renderSettingsTabsList, resetClassForm, selectSwatch, startEditClass, switchSettingsPage, tabItemLabel, updateSettingsLabels };
