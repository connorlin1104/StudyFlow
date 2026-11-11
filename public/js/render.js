import { folderChildren, groupChildren, state } from './state.js';
import { applySelectionStyles, clearSelection } from './selection.js';
import { prefs } from './prefs.js';
import { esc, parseDeadline } from './utils.js';
import { addClassDragBehavior, attachDrag } from './drag.js';
import { fileIcon, isImageType } from './attachments.js';
import { openGroupForm, openSettings, populateSettingsTabSelect, resetClassForm } from './settings.js';

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

export { renderSchedule, renderTabBar, setActiveTab };
