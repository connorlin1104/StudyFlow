import { selKey, splitKey, state } from './state.js';
import { handleSelectClick, sel, selectionKeys } from './selection.js';
import { esc } from './utils.js';
import { moveClasses, moveItems } from './drag.js';
import { startEditClass } from './settings.js';
import { openHwEditModal, openHwModal } from './hw-modal.js';
import { deleteClasses, deleteItems } from './handlers.js';
import { disbandFolder, promptNewFolder, promptRenameFolder } from './folders.js';

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

export { itemsInKeys, openContextMenu };
