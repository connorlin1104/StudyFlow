import { api, batchDelete, deleteAttachments, userCol } from './api.js';
import { resortClasses, selKey, state } from './state.js';
import { clearSelection } from './selection.js';
import { CANCELLED, history } from './history.js';
import { article } from './constants.js';
import { normalizePeriod, showConfirm, toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';
import { itemsInKeys } from './contextmenu.js';
import { formAttachments } from './attachments.js';
import { renderSummary } from './summary.js';
import { closeGroupForm, closeSettings, populateSettingsTabSelect, renderSettingsClassList, renderSettingsTabsList, tabItemLabel } from './settings.js';
import { closeHwModal } from './hw-modal.js';
import { deadlineMsFor, ymd } from './calendar-dates.js';
import { parseDuration } from './duration.js';
import { readFormSubtasks } from './subtask-form.js';
import { subtaskProgress, toggleSubtask } from './subtasks.js';
import { readRepeatInput } from './repeat-form.js';
import { firstDue, nextDue } from './recurrence.js';

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
  if (!classId || !description) {
    // The form is novalidate, so this is the only check — and returning with
    // the button still disabled used to leave it dead until a reload.
    toast(description ? 'Pick a group first.' : 'Add a description first.', 'warning');
    document.getElementById(description ? 'hw-class' : 'hw-desc').focus();
    submitBtn.disabled = false;
    return;
  }

  // A typed estimate that doesn't read as a duration stops the save rather
  // than being dropped without a word.
  const estimateRaw = document.getElementById('hw-estimate').value.trim();
  const estimateMin = estimateRaw ? parseDuration(estimateRaw) : null;
  if (estimateRaw && !estimateMin) {
    toast('Estimate should look like 45m, 1h or 1h 30m.', 'warning');
    document.getElementById('hw-estimate').focus();
    submitBtn.disabled = false;
    return;
  }

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

  // A repeating assignment counts from its due date, so one saved without a
  // date gets the first day its rule lands on (the form's hint says which).
  const repeat = readRepeatInput(deadline);
  if (repeat && !deadline) deadline = firstDue(repeat, ymd(new Date()));

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

  const folderId    = document.getElementById('hw-folder-id').value;
  const reminderVal = document.getElementById('hw-reminder').value;
  const remindBefore = deadline && reminderVal !== '' ? parseInt(reminderVal) : null;

  /* A date with no time means "sometime that day", so it ends the day rather
     than starting it — the same 23:59 the sort comparators already assume.
     Reading it as midnight put the whole day in the past and made reminders
     land the evening before ("1 hour before" arrived at 11pm on the 6th for
     something due on the 7th). Only the reminder sender reads deadlineMs; the
     calendar's drag-to-reschedule computes it with the same helper. */
  const deadlineMs = deadlineMsFor(deadline, deadlineTime);

  const attachments = formAttachments
    .filter(a => a.url && !a.error)
    .map(({ name, type, url, storagePath }) => ({ name, type, url, storagePath }));
  const priority = document.querySelector('input[name="hw-priority"]:checked')?.value;
  const priorityVal = priority === 'high' || priority === 'low' ? priority : null;
  const subtasks    = readFormSubtasks();

  /* Editing sends every field, empty ones as null or '', because
     api.homework.update skips anything undefined — leaving a field out of the
     payload keeps the old value. That's how clearing a due date, notes or the
     last attachment in this form used to silently do nothing. */
  const payload = editId ? {
    classId, description, notes, attachments, remindBefore,
    deadline:     deadline     || null,
    deadlineTime: deadlineTime || null,
    deadlineMs,
    priority:     priorityVal,
    estimateMin,
    subtasks,
    repeat,
  } : {
    classId, description,
    ...(folderId && state.folders.some(f => f.id === folderId && f.classId === classId) && { folderId }),
    ...(notes             && { notes }),
    ...(attachments.length && { attachments }),
    ...(deadline          && { deadline }),
    ...(deadlineTime      && { deadlineTime }),
    ...(deadlineMs  != null && { deadlineMs }),
    ...(remindBefore != null && { remindBefore }),
    ...(priorityVal       && { priority: priorityVal }),
    ...(estimateMin       && { estimateMin }),
    ...(subtasks.length   && { subtasks }),
    ...(repeat            && { repeat }),
  };

  try {
    if (editId) {
      // ---- EDIT MODE ----
      // Folders belong to one group, so moving an assignment out of its group
      // through this form has to drop it out of whatever folder it was in.
      const before = state.homework.find(h => h.id === editId);
      if (before && before.folderId && before.classId !== classId) payload.folderId = null;
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

      // Undo removes the group again; redo re-creates it (new id each time, so
      // the action tracks whichever id is currently live).
      history.push({
        liveId: created.id,
        async undo() {
          const gone   = this.liveId;
          const hwHere = state.homework.filter(h => h.classId === gone);
          if (hwHere.length && !await showConfirm({
            title: `Undo "${data.name}"?`,
            message: `Removing this ${addedLabel.toLowerCase()} also deletes ${hwHere.length} assignment${hwHere.length !== 1 ? 's' : ''} added to it.`,
            confirmText: 'Undo', icon: '↩️'
          })) throw new Error(CANCELLED);
          await api.classes.remove(gone);
          state.classes  = state.classes.filter(c => c.id !== gone);
          state.folders  = state.folders.filter(f => f.classId !== gone);
          state.homework = state.homework.filter(h => h.classId !== gone);
          renderSettingsClassList(); renderSchedule(); renderSummary();
          toast(`Removed ${addedLabel.toLowerCase()} "${data.name}"`, 'info');
        },
        async redo() {
          const again = await api.classes.create(data);
          this.liveId = again.id;
          state.classes.push(again);
          renderSettingsClassList(); renderSchedule(); renderSummary();
          toast(`Added ${article(addedLabel)} ${addedLabel} "${data.name}"`, 'success');
        }
      });
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
  const prevActiveTabId = state.activeTabId;
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

    history.push({
      liveId: tab.id,
      async undo() {
        const gone   = this.liveId;
        const clsIds = state.classes.filter(c => c.tabId === gone).map(c => c.id);
        const hwHere = state.homework.filter(h => clsIds.includes(h.classId));
        if (clsIds.length && !await showConfirm({
          title: `Undo space "${name}"?`,
          message: `Removing it also deletes ${clsIds.length} group${clsIds.length !== 1 ? 's' : ''} and ${hwHere.length} assignment${hwHere.length !== 1 ? 's' : ''} inside it.`,
          confirmText: 'Undo', icon: '↩️'
        })) throw new Error(CANCELLED);
        await api.tabs.remove(gone);
        state.tabs     = state.tabs.filter(t => t.id !== gone);
        state.classes  = state.classes.filter(c => c.tabId !== gone);
        state.folders  = state.folders.filter(f => !clsIds.includes(f.classId));
        state.homework = state.homework.filter(h => !clsIds.includes(h.classId));
        if (state.activeTabId === gone) {
          state.activeTabId = state.tabs.some(t => t.id === prevActiveTabId)
            ? prevActiveTabId
            : (state.tabs[0]?.id ?? null);
        }
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Removed space "${name}"`, 'info');
      },
      async redo() {
        const again = await api.tabs.create({ name });
        this.liveId = again.id;
        state.tabs.push(again);
        state.activeTabId = again.id;
        renderTabBar(); renderSettingsTabsList();
        populateSettingsTabSelect(again.id); renderSettingsClassList();
        renderSchedule(); renderSummary();
        toast(`Added space "${name}"`, 'success');
      }
    });
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
    state.folders  = state.folders.filter(f => !clsIds.includes(f.classId));
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
        state.folders  = state.folders.filter(f => !rClsIds.includes(f.classId));
        state.homework = state.homework.filter(h => !rClsIds.includes(h.classId));
        if (state.activeTabId === r.id) state.activeTabId = state.tabs.filter(t => t.id !== r.id)[0]?.id ?? null;
        renderTabBar(); renderSchedule(); renderSummary();
        renderSettingsTabsList(); populateSettingsTabSelect(state.activeTabId); renderSettingsClassList();
        toast(`Deleted space "${tab.name}"`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* The next copy of a repeating assignment: everything carried over except
   what belongs to the finished one — attachments (completing deletes them
   from Storage), ticked steps, reminder bookkeeping. It takes the finished
   one's place in a manually ordered list. */
function nextOccurrence(hw) {
  const deadline = nextDue(hw.repeat, hw.deadline, ymd(new Date()));
  if (!deadline) return null;
  const folderOk = hw.folderId && state.folders.some(f => f.id === hw.folderId);
  return {
    classId: hw.classId,
    ...(folderOk && { folderId: hw.folderId }),
    description: hw.description,
    ...(hw.notes && { notes: hw.notes }),
    deadline,
    ...(hw.deadlineTime && { deadlineTime: hw.deadlineTime }),
    deadlineMs: deadlineMsFor(deadline, hw.deadlineTime),
    ...(hw.remindBefore != null && { remindBefore: hw.remindBefore }),
    ...(hw.priority && { priority: hw.priority }),
    ...(hw.estimateMin && { estimateMin: hw.estimateMin }),
    ...(hw.subtasks?.length && { subtasks: hw.subtasks.map(s => ({ ...s, done: false })) }),
    repeat: hw.repeat,
    ...(hw.order != null && { order: hw.order }),
  };
}

const shortDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };

async function handleMarkComplete(hwId) {
  // Capture the hw BEFORE any state changes
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw || hw.completed) return;
  const next = hw.repeat && hw.deadline ? nextOccurrence(hw) : null;

  const setDone = async done => {
    const upd = await api.homework.update(hwId, { completed: done });
    const j = state.homework.findIndex(h => h.id === hwId);
    if (j !== -1) state.homework[j] = { ...state.homework[j], ...upd, completed: done };
  };
  const spawn = async () => {
    const created = await api.homework.create(next);
    state.homework.push(created);
    return created.id;
  };
  const doneToast = () => toast(next ? `Completed "${hw.description}" — next one due ${shortDate(next.deadline)}`
                                     : `Completed "${hw.description}"`, 'success');

  try {
    await setDone(true);
    let spawnedId = null;
    // If the next copy can't be made, don't leave it finished with nothing
    // coming after it — the error toast plus an unticked box says try again.
    if (next) {
      try { spawnedId = await spawn(); }
      catch (err) { await setDone(false).catch(() => {}); renderSchedule(); throw err; }
    }
    renderSchedule();
    renderSummary();
    doneToast();

    history.push({
      // Undo takes back the copy it made too, and redo makes a fresh one
      // (a new id each time, so this tracks whichever one is live).
      spawnedId,
      async undo() {
        if (this.spawnedId) {
          await api.homework.remove(this.spawnedId);
          state.homework = state.homework.filter(h => h.id !== this.spawnedId);
          this.spawnedId = null;
        }
        await setDone(false);
        renderSchedule();
        renderSummary();
        toast(`Restored "${hw.description}"`, 'info');
      },
      async redo() {
        await setDone(true);
        if (next) this.spawnedId = await spawn();
        renderSchedule();
        renderSummary();
        doneToast();
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* Set the priority of several assignments at once (from the right-click menu).
   Undo puts each one back to whatever it had before, which may differ. */
async function setPriority(hwIds, priority) {
  const value  = priority === 'high' || priority === 'low' ? priority : null;
  const before = new Map(hwIds.map(id => [id, state.homework.find(h => h.id === id)?.priority ?? null]));
  const ids    = [...before.keys()].filter(id => state.homework.some(h => h.id === id) && before.get(id) !== value);
  if (!ids.length) return;

  const apply = async valueFor => {
    await Promise.all(ids.map(id => api.homework.update(id, { priority: valueFor(id) })));
    ids.forEach(id => {
      const h = state.homework.find(x => x.id === id);
      if (h) h.priority = valueFor(id);
    });
    renderSchedule();
  };
  const label = value ? `${value} priority` : 'normal priority';
  const what  = ids.length === 1 ? `"${state.homework.find(h => h.id === ids[0]).description}"` : `${ids.length} assignments`;
  try {
    await apply(() => value);
    toast(`Set ${what} to ${label}`, 'success');
    history.push({
      async undo() { await apply(id => before.get(id)); toast(`Restored priority on ${what}`, 'info'); },
      async redo() { await apply(() => value);          toast(`Set ${what} to ${label}`, 'success'); }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* Ticking a step on the card. State changes first so the card redraws right
   away; the whole list is written back, so two quick ticks both land as long
   as the writes go out in order (one client, one document — they do). */
async function setSubtaskDone(hwId, stepId, done) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw?.subtasks?.some(s => s.id === stepId)) return;
  const text = hw.subtasks.find(s => s.id === stepId).text;

  const apply = async value => {
    const h = state.homework.find(x => x.id === hwId);
    if (!h) return;
    const prev = h.subtasks;
    h.subtasks = toggleSubtask(h.subtasks, stepId, value);
    renderSchedule();
    try {
      await api.homework.update(hwId, { subtasks: h.subtasks });
    } catch (err) {
      h.subtasks = prev;
      renderSchedule();
      throw err;
    }
  };
  try {
    await apply(done);
    const p = subtaskProgress(hw);
    if (done && p.done === p.total) toast(`All steps done for "${hw.description}"`, 'success');
    history.push({
      async undo() { await apply(!done); toast(`${done ? 'Unticked' : 'Ticked'} "${text}"`, 'info'); },
      async redo() { await apply(done);  toast(`${done ? 'Ticked' : 'Unticked'} "${text}"`, 'info'); }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

/* -----------------------------------------------------------------------------
   DELETE — assignments and folders

   One code path for a single right-click delete and for a whole selection. A
   folder in the pile takes its contents with it; use Disband to keep them.
   ----------------------------------------------------------------------------- */
async function deleteItems(keys) {
  const { folders, hw } = itemsInKeys(keys);
  if (!folders.length && !hw.length) return;

  // Count only what's actually on the board. Completed assignments get deleted
  // too, but they're hidden from every view, so naming them here only raises
  // questions about assignments the user has no way to go and look at.
  const active   = hw.filter(h => !h.completed).length;
  const single   = keys.length === 1;
  const title = single && folders.length ? `Delete folder "${folders[0].name}"?`
              : single && hw.length      ? `Delete "${hw[0].description}"?`
              :                            `Delete ${keys.length} items?`;
  const counts = [
    folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : '',
    active         ? `${active} assignment${active === 1 ? '' : 's'}`             : ''
  ].filter(Boolean).join(' and ');
  const message = folders.length
    ? `This deletes ${counts}, including everything inside the folder${folders.length === 1 ? '' : 's'}. Disband a folder instead to keep its assignments.`
    : single ? '' : `This deletes ${counts}.`;

  if (!await showConfirm({ title, message, confirmText: single ? 'Delete' : `Delete ${keys.length} Items`, icon: '🗑️' })) return;

  try {
    await Promise.all(hw.filter(h => h.attachments?.length).map(h => deleteAttachments(h.attachments)));
    await batchDelete([
      ...folders.map(f => userCol('folders').doc(f.id)),
      ...hw.map(h => userCol('homework').doc(h.id))
    ]);

    const goneF = new Set(folders.map(f => f.id));
    const goneH = new Set(hw.map(h => h.id));
    state.folders  = state.folders.filter(f => !goneF.has(f.id));
    state.homework = state.homework.filter(h => !goneH.has(h.id));
    clearSelection();
    renderSchedule();
    renderSummary();
    toast(single && hw.length && !folders.length ? `Deleted "${hw[0].description}"`
        : single && folders.length              ? `Deleted folder "${folders[0].name}"`
        : `Deleted ${keys.length} items`, 'info');

    /* Attachments are already gone from Storage, so they can't come back — but
       `completed` has to survive, or undo puts finished work back on the board.
       Folders come back under their original ids, because every assignment being
       restored alongside them still points at that id through `folderId`. */
    const folderSnaps = folders.map(({ createdAt: _c, ...f }) => f);
    const hwSnaps     = hw.map(({ id: _i, createdAt: _c, attachments: _a, ...f }) => f);
    history.push({
      liveHwIds: [],
      async undo() {
        const rf = await Promise.all(folderSnaps.map(f => api.folders.create(f)));
        state.folders.push(...rf);
        const rh = await Promise.all(hwSnaps.map(f => api.homework.create(f)));
        this.liveHwIds = rh.map(h => h.id);
        state.homework.push(...rh);
        renderSchedule(); renderSummary();
        toast(single ? 'Restored' : `Restored ${keys.length} items`, 'success');
      },
      async redo() {
        await batchDelete([
          ...this.liveHwIds.map(id => userCol('homework').doc(id)),
          ...folderSnaps.map(f => userCol('folders').doc(f.id))
        ]);
        const liveH = new Set(this.liveHwIds);
        const liveF = new Set(folderSnaps.map(f => f.id));
        state.homework = state.homework.filter(h => !liveH.has(h.id));
        state.folders  = state.folders.filter(f => !liveF.has(f.id));
        renderSchedule(); renderSummary();
        toast(single ? 'Deleted' : `Deleted ${keys.length} items`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

function handleDeleteHw(hwId) { return deleteItems([selKey('hw', hwId)]); }

/* -----------------------------------------------------------------------------
   DELETE — groups
   ----------------------------------------------------------------------------- */
async function deleteClasses(ids) {
  const classes = ids.map(id => state.classes.find(c => c.id === id)).filter(Boolean);
  if (!classes.length) return;
  const idSet   = new Set(classes.map(c => c.id));
  const folders = state.folders.filter(f => idSet.has(f.classId));
  const clsHw   = state.homework.filter(h => idSet.has(h.classId));
  const active  = clsHw.filter(h => !h.completed).length;
  const single  = classes.length === 1;
  const label   = tabItemLabel(classes[0].tabId);

  const subMsg = active ? `This will also delete ${active} assignment${active === 1 ? '' : 's'}.` : '';
  if (!await showConfirm({
    title:       single ? `Delete "${classes[0].name}"?` : `Delete ${classes.length} groups?`,
    message:     subMsg,
    confirmText: single ? `Delete ${label}` : `Delete ${classes.length} Groups`,
    icon: '🗑️'
  })) return;

  try {
    for (const c of classes) await api.classes.remove(c.id);
    state.classes  = state.classes.filter(c => !idSet.has(c.id));
    state.folders  = state.folders.filter(f => !idSet.has(f.classId));
    state.homework = state.homework.filter(h => !idSet.has(h.classId));
    clearSelection();
    renderSettingsClassList(); renderSchedule(); renderSummary();
    toast(single ? `Deleted ${label} "${classes[0].name}"` : `Deleted ${classes.length} groups`, 'info');

    // Groups come back with fresh ids, so everything that pointed at one has to
    // be re-pointed. Folders keep their own ids — the assignments being restored
    // beside them still reference those through `folderId`.
    const clsSnaps    = classes.map(({ id, createdAt: _c, ...f }) => ({ origId: id, fields: f }));
    const folderSnaps = folders.map(({ classId, createdAt: _c, ...f }) => ({ origClassId: classId, fields: f }));
    const hwSnaps     = clsHw.map(({ id: _i, classId, createdAt: _c, attachments: _a, ...f }) => ({ origClassId: classId, fields: f }));
    history.push({
      liveClassIds: [],
      async undo() {
        const map = {}, restored = [];
        for (const c of clsSnaps) {
          const r = await api.classes.create(c.fields);
          map[c.origId] = r.id;
          restored.push(r);
        }
        state.classes.push(...restored);
        this.liveClassIds = restored.map(c => c.id);
        const rf = await Promise.all(folderSnaps.map(f => api.folders.create({ ...f.fields, classId: map[f.origClassId] })));
        state.folders.push(...rf);
        const rh = await Promise.all(hwSnaps.map(h => api.homework.create({ ...h.fields, classId: map[h.origClassId] })));
        state.homework.push(...rh);
        resortClasses();
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(single ? `Restored ${label} "${classes[0].name}"` : `Restored ${classes.length} groups`, 'success');
      },
      async redo() {
        if (!this.liveClassIds.length) return;
        const live = new Set(this.liveClassIds);
        for (const id of this.liveClassIds) await api.classes.remove(id);
        state.classes  = state.classes.filter(c => !live.has(c.id));
        state.folders  = state.folders.filter(f => !live.has(f.classId));
        state.homework = state.homework.filter(h => !live.has(h.classId));
        renderSettingsClassList(); renderSchedule(); renderSummary();
        toast(single ? `Deleted ${label} "${classes[0].name}"` : `Deleted ${classes.length} groups`, 'info');
      }
    });
  } catch (err) { toast(`Error: ${err.message}`, 'error'); }
}

function handleDeleteClass(classId) { return deleteClasses([classId]); }

export { deleteClasses, deleteItems, handleAddHomework, setPriority, setSubtaskDone, handleAddTab, handleClassFormSubmit, handleDeleteClass, handleDeleteHw, handleDeleteTab, handleMarkComplete };
