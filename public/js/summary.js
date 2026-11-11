import { state } from './state.js';
import { prefs } from './prefs.js';
import { esc, parseDeadline } from './utils.js';

/* =============================================================================
   RENDER — SUMMARY PANEL (all pending, sorted by deadline)
   ============================================================================= */
function renderSummary() {
  const list       = document.getElementById('summary-list');
  const empty      = document.getElementById('summary-empty');
  const countBadge = document.getElementById('summary-count');

  const pending = state.homework
    .filter(h => !h.completed)
    .sort((a,b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      const ta = new Date(a.deadline + (a.deadlineTime ? `T${a.deadlineTime}` : 'T23:59'));
      const tb = new Date(b.deadline + (b.deadlineTime ? `T${b.deadlineTime}` : 'T23:59'));
      return ta - tb;
    });

  countBadge.textContent = pending.length;
  countBadge.classList.toggle('hidden', pending.length === 0);

  if (pending.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';

  function buildSummaryItem(hw, showBadge) {
    const cls = state.classes.find(c => c.id === hw.classId);
    if (!cls) return null;
    const tab  = state.tabs.find(t => t.id === cls.tabId);
    const dl   = parseDeadline(hw.deadline, hw.deadlineTime);
    const item = document.createElement('div');
    item.className = 'summary-item';
    item.style.setProperty('--color', cls.color || '#94a3b8');
    const metaParts = [cls.name];
    if (tab && tab.id !== 'classes') metaParts.push(tab.name);
    const badgeHtml = showBadge && dl
      ? `<span class="deadline-badge ${dl.cssClass}">${esc(dl.label)}</span>`
      : '';
    item.innerHTML = `
      <div class="summary-color-bar"></div>
      <div class="summary-body">
        <span class="summary-desc">${esc(hw.description)}</span>
        <span class="summary-meta">${esc(metaParts.join(' · '))}</span>
      </div>
      <div class="summary-aside">
        ${badgeHtml}
        <div class="summary-actions">
          <button class="summary-btn summary-btn--edit" data-hw-id="${hw.id}" title="Edit">&#9998; Edit</button>
          <button class="summary-btn summary-btn--done" data-hw-id="${hw.id}" title="Mark complete">&#10003; Done</button>
        </div>
      </div>
    `;
    return item;
  }

  const withDate = pending.filter(h => h.deadline);
  const noDate   = pending.filter(h => !h.deadline);

  withDate.forEach(hw => {
    const item = buildSummaryItem(hw, true);
    if (item) list.appendChild(item);
  });

  if (noDate.length > 0) {
    const collapsed = prefs.get('summaryNodateCollapsed', false);
    const section = document.createElement('div');
    section.className = `summary-nodate-section${collapsed ? ' summary-nodate-section--collapsed' : ''}`;
    section.innerHTML = `
      <button class="summary-nodate-toggle">
        <span class="summary-nodate-label">No Due Date</span>
        <span class="summary-nodate-ct">${noDate.length}</span>
        <span class="summary-nodate-chevron">${collapsed ? '▾' : '▴'}</span>
      </button>
      <div class="summary-nodate-items"></div>
    `;
    const itemsEl = section.querySelector('.summary-nodate-items');
    noDate.forEach(hw => {
      const item = buildSummaryItem(hw, false);
      if (item) itemsEl.appendChild(item);
    });
    list.appendChild(section);
  }
}

export { renderSummary };
