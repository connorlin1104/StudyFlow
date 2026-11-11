import { writeOrders } from './api.js';
import { containerItems, folderChildren, groupChildren, resortClasses, selKey, splitKey, state } from './state.js';
import { clearSelection, elementForKey, sel, selectionKeys } from './selection.js';
import { history } from './history.js';
import { toast } from './utils.js';
import { renderSchedule, renderTabBar, setActiveTab } from './render.js';
import { renderSummary } from './summary.js';
import { renderSettingsClassList } from './settings.js';

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

export { addClassDragBehavior, applyBoardLocally, attachDrag, moveClasses, moveItems, persistPlacement, restoreBoard, snapshotBoard };
