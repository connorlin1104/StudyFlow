import { api } from './api.js';
import { folderChildren, groupChildren, selKey, state } from './state.js';
import { clearSelection } from './selection.js';
import { history } from './history.js';
import { toast } from './utils.js';
import { renderSchedule } from './render.js';
import { applyBoardLocally, persistPlacement, restoreBoard, snapshotBoard } from './drag.js';
import { renderSummary } from './summary.js';

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

export { disbandFolder, promptNewFolder, promptRenameFolder };
