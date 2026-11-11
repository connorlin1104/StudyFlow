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

export { containerItems, folderChildren, groupChildren, keyKind, resortClasses, selKey, splitKey, state };
