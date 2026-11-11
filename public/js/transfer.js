import { api } from './api.js';
import { resortClasses, state } from './state.js';
import { showConfirm, toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';
import { renderSummary } from './summary.js';
import { populateSettingsTabSelect, renderSettingsClassList, renderSettingsTabsList } from './settings.js';

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
    folders: state.folders.map(({ id, createdAt: _c, ...rest }) => ({ _origId: id, ...rest })),
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
    await Promise.all(state.folders.map(f => api.folders.remove(f.id)));
    await Promise.all(state.classes.map(c => api.classes.remove(c.id)));
    await Promise.all(state.tabs.map(t => api.tabs.remove(t.id)));

    state.tabs     = [];
    state.classes  = [];
    state.folders  = [];
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

    const folderIdMap = {};
    for (const f of (data.folders || [])) {
      const { _origId, classId, ...body } = f;
      const newClassId = clsIdMap[classId];
      if (!newClassId) continue;
      const created = await api.folders.create({ ...body, classId: newClassId });
      state.folders.push(created);
      folderIdMap[_origId] = created.id;
    }

    for (const h of (data.homework || [])) {
      const { _origId, classId, folderId, ...body } = h;
      const newClassId = clsIdMap[classId];
      if (!newClassId) continue;
      const created = await api.homework.create({
        ...body, classId: newClassId,
        ...(folderId && folderIdMap[folderId] && { folderId: folderIdMap[folderId] })
      });
      state.homework.push(created);
    }
    resortClasses();

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

export { downloadSchedule, loadSchedule };
