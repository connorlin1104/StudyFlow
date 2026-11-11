import { keyKind, selKey, splitKey, state } from './state.js';

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

export { applySelectionStyles, clearSelection, elementForKey, handleSelectClick, sel, selectionKeys };
