import { api } from './api.js';
import { state } from './state.js';
import { toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';
import { renderSummary } from './summary.js';
import { openSettings, populateSettingsTabSelect, renderSettingsClassList, renderSettingsTabsList } from './settings.js';

/* =============================================================================
   TEMPLATES
   ============================================================================= */
async function applyTemplate(btnId, templateName, tabs) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  try {
    let firstTabId = null;
    for (const tabDef of tabs) {
      const tab = await api.tabs.create({ name: tabDef.name });
      state.tabs.push(tab);
      if (!firstTabId) firstTabId = tab.id;
      for (const cls of tabDef.classes) {
        const created = await api.classes.create({ ...cls, tabId: tab.id });
        state.classes.push(created);
      }
    }

    state.activeTabId = firstTabId;
    renderTabBar();
    renderSchedule();
    renderSummary();
    renderSettingsTabsList();
    populateSettingsTabSelect(firstTabId);
    renderSettingsClassList();
    openSettings('classes');
    toast(`${templateName} template applied — edit your topics below`, 'success');
  } catch (err) {
    toast(`Template failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function applyStudentTemplate() {
  return applyTemplate('student-template-btn', 'High School', [
    { name: 'Classes', classes: [
      { name: 'English',  color: '#ef4444' },
      { name: 'Math',     color: '#3b82f6' },
      { name: 'Science',  color: '#22c55e' },
      { name: 'History',  color: '#f97316' },
      { name: 'Elective', color: '#8b5cf6' },
      { name: 'Elective', color: '#ec4899' },
      { name: 'Elective', color: '#14b8a6' },
      { name: 'Elective', color: '#eab308' },
    ]},
  ]);
}

function applyCollegeTemplate() {
  return applyTemplate('college-template-btn', 'College', [
    { name: 'Classes', classes: [
      { name: 'Major Course 1', color: '#3b82f6' },
      { name: 'Major Course 2', color: '#6366f1' },
      { name: 'Major Course 3', color: '#8b5cf6' },
      { name: 'Gen Ed 1',       color: '#22c55e' },
      { name: 'Gen Ed 2',       color: '#14b8a6' },
      { name: 'Elective 1',     color: '#f97316' },
      { name: 'Elective 2',     color: '#eab308' },
    ]},
  ]);
}

function applyWorkTemplate() {
  return applyTemplate('work-template-btn', 'Work', [
    { name: 'Work', classes: [
      { name: 'Projects',    color: '#3b82f6' },
      { name: 'Meetings',    color: '#8b5cf6' },
      { name: 'Tasks',       color: '#22c55e' },
      { name: 'Follow-ups',  color: '#f97316' },
      { name: 'Admin',       color: '#64748b' },
    ]},
  ]);
}

function applyPersonalTemplate() {
  return applyTemplate('personal-template-btn', 'Personal', [
    { name: 'Personal', classes: [
      { name: 'Errands',      color: '#22c55e' },
      { name: 'Appointments', color: '#3b82f6' },
      { name: 'Goals',        color: '#8b5cf6' },
      { name: 'Reminders',    color: '#f97316' },
      { name: 'Health',       color: '#ef4444' },
    ]},
  ]);
}

export { applyCollegeTemplate, applyPersonalTemplate, applyStudentTemplate, applyWorkTemplate };
