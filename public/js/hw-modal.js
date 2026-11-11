import { state } from './state.js';
import { esc, toast } from './utils.js';
import { renderFormAttachments, setFormAttachments } from './attachments.js';

/* =============================================================================
   HOMEWORK MODAL
   ============================================================================= */
function openHwModal(preselectedClassId = null, preselectedFolderId = null) {
  if (state.classes.length === 0) {
    toast('Add some topics first in Settings.', 'warning');
    return;
  }
  document.getElementById('hw-form').reset();
  document.getElementById('hw-reminder').value = '';
  document.getElementById('hw-edit-id').value = '';
  document.getElementById('hw-folder-id').value = preselectedFolderId || '';
  document.getElementById('hw-modal-title').textContent = 'New Assignment';
  document.getElementById('hw-form-submit').textContent = 'Add to Schedule';
  document.getElementById('hw-reminder-group').classList.add('hidden');
  setFormAttachments([]);
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
  reminderSel.value = hw.remindBefore != null ? String(hw.remindBefore) : '';
  document.getElementById('hw-reminder-group').classList.toggle('hidden', !hw.deadline);

  document.getElementById('hw-modal-title').textContent   = 'Edit Assignment';
  document.getElementById('hw-form-submit').textContent   = 'Save Changes';

  // Load existing attachments into form state
  setFormAttachments((hw.attachments || []).map(a => ({
    ...a,
    id: `att-${Math.random().toString(36).slice(2)}`,
    localUrl: null, uploading: false, error: false
  })));
  renderFormAttachments();
}

function closeHwModal() {
  document.getElementById('hw-modal').classList.remove('modal--open');
}

export { closeHwModal, openHwEditModal, openHwModal };
