import { api } from './api.js';
import { state } from './state.js';
import { prefs } from './prefs.js';
import { esc, toast } from './utils.js';
import { formatDuration } from './duration.js';
import { subtaskProgress } from './subtasks.js';
import { describeRepeat } from './recurrence.js';
import { DEFAULT_BUDGET, GUESS_MIN, heavyDays, planDay } from './planner.js';
import { openHwEditModal } from './hw-modal.js';
import { handleMarkComplete } from './handlers.js';

/* =============================================================================
   TODAY VIEW — "plan my day"

   The fourth view beside Board / Week / Month. Like the calendar it covers
   every space at once and draws into #calendar-container, so it's redrawn by
   renderSchedule() through renderCalendar() whenever anything changes.
   planner.js decides what's in the plan; this only draws it.

   The daily study time lives in userPrefs/{uid}.dailyBudgetMin (shared across
   devices), with prefs as the local copy so the first paint doesn't wait.
   ============================================================================= */

const BUDGET_CHOICES = [30, 60, 90, 120, 150, 180, 240, 300, 360];

function budget() {
  const b = prefs.get('dailyBudgetMin', DEFAULT_BUDGET);
  return b > 0 ? b : DEFAULT_BUDGET;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const niceDay = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
};
function shortTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h >= 12 ? 'pm' : 'am'}`;
}

const REASON = {
  today:    'Due today',
  tomorrow: 'Due tomorrow',
};

function dueLabel(item) {
  const { hw, reason } = item;
  const at = hw.deadlineTime ? ` ${shortTime(hw.deadlineTime)}` : '';
  if (reason === 'overdue') return hw.deadline === ymd(new Date()) ? `Was due${at} today` : `Was due ${niceDay(hw.deadline)}`;
  if (REASON[reason]) return `${REASON[reason]}${at}`;
  if (reason === 'later') return `Due ${niceDay(hw.deadline)}`;
  return 'No due date';
}

function itemHtml(item, cls) {
  const { hw, minutes, guess, reason } = item;
  const steps = subtaskProgress(hw);
  const repeats = describeRepeat(hw.repeat);
  const sub = [esc(cls.name), esc(dueLabel(item)), steps && `${steps.done}/${steps.total} steps`].filter(Boolean).join(' · ');
  const time = guess
      ? `<span class="today-min today-min--guess" title="No estimate, so this counts as ${formatDuration(GUESS_MIN)}. Add one in the form.">~${formatDuration(minutes)}</span>`
      : `<span class="today-min" title="Time left, going by the estimate">${formatDuration(minutes)}</span>`;
  return `<li class="today-item today-item--${reason}${hw.priority === 'high' ? ' today-item--high' : ''}" data-hw-id="${esc(hw.id)}" style="--color:${esc(cls.color || '#94a3b8')}">
    <label class="hw-check-label" title="Mark complete">
      <input type="checkbox" class="hw-check today-check" data-hw-id="${esc(hw.id)}" aria-label="Mark “${esc(hw.description)}” complete">
      <span class="custom-check"></span>
    </label>
    <button class="today-body" data-today-edit="${esc(hw.id)}">
      <span class="today-desc">${hw.priority === 'high' ? '<span class="prio-flag" aria-label="High priority">!</span>' : ''}${esc(hw.description)}${repeats ? `<span class="repeat-mark" title="${esc(repeats)}" aria-label="${esc(repeats)}">↻</span>` : ''}</span>
      <span class="today-sub">${sub}</span>
    </button>
    ${time}
  </li>`;
}

function renderToday(root) {
  const now = new Date();
  const classById = new Map(state.classes.map(c => [c.id, c]));
  // Skip assignments whose group is gone (an interrupted cascade delete).
  const live = state.homework.filter(h => classById.has(h.classId));
  const b = budget();
  const plan = planDay(live, { now, budgetMin: b });
  const heavy = heavyDays(live, { now, budgetMin: b });

  const pct = Math.min(100, Math.round(plan.plannedMin / b * 100));
  const budgetSelect = `<select id="today-budget" aria-label="Daily study time">${
    [...new Set([...BUDGET_CHOICES, b])].sort((x, y) => x - y)
      .map(m => `<option value="${m}"${m === b ? ' selected' : ''}>${formatDuration(m)} a day</option>`).join('')}</select>`;

  const guesses = plan.items.filter(i => i.guess).length;
  const summary = plan.items.length
    ? `<strong>${formatDuration(plan.plannedMin)}</strong> of work today, out of ${formatDuration(b)} · ${plan.items.length} assignment${plan.items.length !== 1 ? 's' : ''}${
        guesses ? ` · <span title="Assignments without an estimate count as ${formatDuration(GUESS_MIN)} each">${guesses} guessed</span>` : ''}`
    : '';

  const over = plan.overBy
    ? `<p class="today-alert today-alert--over" role="status">That&rsquo;s ${formatDuration(plan.overBy)} more than your ${formatDuration(b)} of study time. Do the top of the list first.</p>`
    : '';

  const heavyHtml = heavy.length
    ? `<section class="today-heavy">
        <h3 class="today-section-title">Heavy days coming up</h3>
        <ul>${heavy.map(d => `<li><button class="today-heavy-day" data-today-week="${d.date}">
          <strong>${esc(d.date === ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) ? 'Tomorrow' : niceDay(d.date, { weekday: 'long' }))}</strong>: ${formatDuration(d.totalMin)} due across ${d.count} assignment${d.count !== 1 ? 's' : ''}
          </button> &mdash; more than a day&rsquo;s ${formatDuration(b)}, so start some early.</li>`).join('')}</ul>
      </section>`
    : '';

  const seeWeek = `<button class="link-btn" data-today-view="week">See the week</button>`;
  let body;
  if (plan.items.length) {
    body = `<ol class="today-list">${plan.items.map(i => itemHtml(i, classById.get(i.hw.classId))).join('')}</ol>`;
  } else if (plan.suggestions.length) {
    body = `<div class="today-empty today-empty--compact"><p><strong>Nothing is due today.</strong></p></div>
      <section class="today-suggest">
        <h3 class="today-section-title">Want to get ahead? Coming up next</h3>
        <ol class="today-list today-list--suggest">${plan.suggestions.map(i => itemHtml(i, classById.get(i.hw.classId))).join('')}</ol>
      </section>`;
  } else {
    body = `<div class="today-empty"><div class="today-empty-icon" aria-hidden="true">🎉</div><p>Nothing is due today, and nothing coming up. Enjoy it.</p></div>`;
  }

  const later = plan.upcoming
    ? `<p class="today-later">${plan.upcoming} more assignment${plan.upcoming !== 1 ? 's' : ''} due later. ${seeWeek}</p>`
    : '';

  root.innerHTML = `<div class="today">
    <div class="today-head">
      <div>
        <h2 class="today-title">Today</h2>
        <p class="today-date">${esc(now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
      </div>
      <label class="today-budget">Study time ${budgetSelect}</label>
    </div>
    ${plan.items.length ? `<div class="today-meter${plan.plannedMin > b ? ' today-meter--over' : ''}" role="progressbar" aria-label="Planned time" aria-valuemin="0" aria-valuemax="${b}" aria-valuenow="${plan.plannedMin}"><div class="today-meter-fill" style="width:${pct}%"></div></div>
    <p class="today-summary">${summary}</p>` : ''}
    ${over}
    ${body}
    ${later}
    ${heavyHtml}
  </div>`;
}

/** Bring an assignment in today's plan into view and flash it. False if it
 *  isn't in the plan, so the caller can go to the board instead. */
function revealInToday(root, hwId) {
  const el = root.querySelector(`.today-item[data-hw-id="${CSS.escape(hwId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('palette-flash');
  el.addEventListener('animationend', () => el.classList.remove('palette-flash'), { once: true });
  return true;
}

/** `goTo(view, date)` switches views; calendar.js passes it in so this module
 *  doesn't import calendar.js back. */
function wireToday(root, goTo) {
  root.addEventListener('change', e => {
    const cb = e.target.closest('.today-check');
    if (cb) { handleMarkComplete(cb.dataset.hwId); return; }
    if (e.target.id === 'today-budget') {
      const minutes = +e.target.value;
      prefs.set('dailyBudgetMin', minutes);
      renderToday(root);
      api.notifications.setDailyBudget(minutes)
        .catch(err => toast(`Couldn't save your study time to other devices: ${err.message}`, 'warning'));
    }
  });
  root.addEventListener('click', e => {
    const edit = e.target.closest('[data-today-edit]');
    if (edit) { openHwEditModal(edit.dataset.todayEdit); return; }
    const week = e.target.closest('[data-today-week]');
    if (week) { goTo('week', week.dataset.todayWeek); return; }
    const view = e.target.closest('[data-today-view]');
    if (view) goTo(view.dataset.todayView);
  });
}

export { renderToday, revealInToday, wireToday };
