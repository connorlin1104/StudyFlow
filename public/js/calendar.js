import { api } from './api.js';
import { defaultClassId, state } from './state.js';
import { history } from './history.js';
import { prefs } from './prefs.js';
import { clearSelection } from './selection.js';
import { esc, parseDeadline, toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';
import { renderSummary } from './summary.js';
import { openHwEditModal, openHwModalPrefilled } from './hw-modal.js';
import { formatDuration, totalEstimate } from './duration.js';
import { bucket, deadlineMsFor, monthGrid, parseYmd, rangeLabel, shiftAnchor, viewRange, weekDays, ymd } from './calendar-dates.js';

/* =============================================================================
   CALENDAR VIEW  (Week / Month, next to the Board)

   Shows pending work from every space at once, colored by group, because the
   point of a calendar is seeing what piles up on the same day, and a clash
   between two spaces is still a clash. Clicking a space tab goes back to that
   space's board.

   This isn't a second copy of the data. renderSchedule() calls renderCalendar()
   instead of drawing the board while a calendar view is on, so every add,
   edit, undo and refresh that already re-renders the board keeps this current.
   ============================================================================= */

const VIEWS = ['board', 'week', 'month'];
let view   = VIEWS.includes(prefs.get('view')) ? prefs.get('view') : 'board';
let anchor = new Date();          // any day inside the week/month on screen

const $ = id => document.getElementById(id);
const isPhone = () => matchMedia('(max-width: 600px)').matches;

// A calendar of nothing isn't useful; with no groups yet the board's welcome
// screen is what should show, whatever the saved view says.
function isCalendarView() { return view !== 'board' && state.classes.length > 0; }

function currentView() { return view; }

/** Switch views. `render: false` lets setActiveTab() do the drawing itself. */
function setView(next, { render = true } = {}) {
  if (!VIEWS.includes(next)) return;
  if (next !== 'board') clearSelection();   // selection is a board-only idea
  view = next;
  prefs.set('view', next);
  updateToggle();
  if (render) { renderTabBar(); renderSchedule(); }
}

function updateToggle() {
  const shown = isCalendarView() ? view : 'board';
  document.querySelectorAll('.view-btn').forEach(b => {
    const on = b.dataset.view === shown;
    b.classList.toggle('view-btn--active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function step(dir) {
  anchor = dir === 0 ? new Date() : shiftAnchor(view, anchor, dir);
  renderCalendar();
}

/* -----------------------------------------------------------------------------
   Drawing
   ----------------------------------------------------------------------------- */
function shortTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'p' : 'a'}`;
}

// `sub` is an optional second line (group name, or group · due date).
function itemHtml(hw, cls, { sub = '', showTime = true, today }) {
  const overdue = hw.deadline < today
    || (hw.deadline === today && hw.deadlineTime && new Date(`${hw.deadline}T${hw.deadlineTime}`) < new Date());
  const time = showTime ? shortTime(hw.deadlineTime) : '';
  const high = hw.priority === 'high', low = hw.priority === 'low';
  return `<div class="cal-item${overdue ? ' cal-item--overdue' : ''}${high ? ' cal-item--high' : low ? ' cal-item--low' : ''}" data-hw-id="${esc(hw.id)}"
      style="--color:${esc(cls.color || '#94a3b8')}" title="${high ? 'High priority: ' : ''}${esc(hw.description)} — ${esc(cls.name)}">
    <span class="cal-item-line">${high ? '<span class="prio-flag" aria-label="High priority">!</span>' : ''}${time ? `<span class="cal-item-time">${time}</span>` : ''}<span class="cal-item-desc">${esc(hw.description)}</span></span>
    ${sub ? `<span class="cal-item-group">${esc(sub)}</span>` : ''}
  </div>`;
}

function dayHtml(date, items, { month, today, classById, inMonth }) {
  const key = ymd(date);
  const classes = ['cal-day'];
  if (key === today) classes.push('cal-day--today');
  if (key < today)   classes.push('cal-day--past');
  if (!inMonth)      classes.push('cal-day--outside');
  const dow  = date.toLocaleDateString('en-US', { weekday: 'short' });
  const full = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const LIMIT = 3;
  const shown = month ? items.slice(0, LIMIT) : items;
  const more  = items.length - shown.length;
  const sub   = hw => [classById.get(hw.classId).name, formatDuration(hw.estimateMin)].filter(Boolean).join(' · ');
  const list  = shown.map(hw => itemHtml(hw, classById.get(hw.classId), { sub: month ? '' : sub(hw), today })).join('');
  // How much work the day holds, from the estimates that have been given.
  const total = formatDuration(totalEstimate(items));
  const head  = month ? total : items.length ? [items.length, total].filter(Boolean).join(' · ') : '';
  // Phones get dots in the month grid; there's no room for titles.
  const dots = month && items.length
    ? `<span class="cal-dots" aria-hidden="true">${items.slice(0, 4).map(hw =>
        `<span style="--color:${esc(classById.get(hw.classId).color || '#94a3b8')}"></span>`).join('')}</span>`
    : '';
  return `<div class="${classes.join(' ')}" data-date="${key}" aria-label="${esc(full)}, ${items.length} due${total ? `, about ${total} of work` : ''}">
    <div class="cal-day-head">
      ${month ? '' : `<span class="cal-dow">${dow}</span>`}
      <span class="cal-dnum">${date.getDate()}</span>
      ${head ? `<span class="cal-day-count"${total ? ` title="${items.length} due, about ${total} of work"` : ''}>${head}</span>` : ''}
    </div>
    <div class="cal-day-items">${list}${more > 0
      ? `<button class="cal-more" data-cal-more="${key}">+${more} more</button>` : ''}</div>
    ${dots}
  </div>`;
}

function extraHtml(title, items, classById, today, cssMod) {
  if (!items.length) return '';
  return `<section class="cal-extra cal-extra--${cssMod}">
    <h3 class="cal-extra-title">${title} <span class="cal-extra-count">${items.length}</span></h3>
    <div class="cal-extra-items">${items.map(hw => {
      const cls = classById.get(hw.classId);
      const due = hw.deadline ? parseDeadline(hw.deadline, hw.deadlineTime) : null;
      const sub = [cls.name, due?.label, formatDuration(hw.estimateMin)].filter(Boolean).join(' · ');
      return itemHtml(hw, cls, { sub, showTime: false, today });
    }).join('')}</div>
  </section>`;
}

function renderCalendar() {
  const root = $('calendar-container');
  $('classes-container').classList.add('hidden');
  $('empty-state').classList.add('hidden');
  root.classList.remove('hidden');

  const month = view === 'month';
  const today = ymd(new Date());
  const classById = new Map(state.classes.map(c => [c.id, c]));
  const range = viewRange(view, anchor);
  // Skip assignments whose group is gone (an interrupted cascade delete).
  const { days, overdue, undated } = bucket(state.homework.filter(h => classById.has(h.classId)), { ...range, today });
  const ctx = { month, today, classById };
  const thisMonth = anchor.getMonth();

  const unit = month ? 'month' : 'week';
  const header = `<div class="cal-toolbar">
      <div class="cal-nav">
        <button class="cal-nav-btn" data-cal-nav="-1" aria-label="Previous ${unit}" title="Previous ${unit} (←)">‹</button>
        <button class="cal-today-btn" data-cal-nav="0">Today</button>
        <button class="cal-nav-btn" data-cal-nav="1" aria-label="Next ${unit}" title="Next ${unit} (→)">›</button>
      </div>
      <h2 class="cal-title">${esc(rangeLabel(view, anchor))}</h2>
    </div>`;

  let grid;
  if (month) {
    const heads = weekDays(new Date()).map(d =>
      `<div class="cal-weekday">${d.toLocaleDateString('en-US', { weekday: 'short' })}</div>`).join('');
    const cells = monthGrid(anchor).flat().map(d =>
      dayHtml(d, days.get(ymd(d)), { ...ctx, inMonth: d.getMonth() === thisMonth })).join('');
    grid = `<div class="cal-grid cal-grid--month">${heads}${cells}</div>`;
  } else {
    grid = `<div class="cal-grid cal-grid--week">${weekDays(anchor).map(d =>
      dayHtml(d, days.get(ymd(d)), { ...ctx, inMonth: true })).join('')}</div>`;
  }

  root.innerHTML = header + grid
    + extraHtml('Overdue', overdue, classById, today, 'overdue')
    + extraHtml('No due date', undated, classById, today, 'undated');
}

function hideCalendar() { $('calendar-container').classList.add('hidden'); $('classes-container').classList.remove('hidden'); }

/** Bring an assignment into view on the calendar and flash it. Returns false
    if it can't be shown here (no due date), so the caller can use the board. */
function revealInCalendar(hwId) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw?.deadline) return false;
  anchor = parseYmd(hw.deadline);
  renderCalendar();
  const el = $('calendar-container').querySelector(`.cal-item[data-hw-id="${CSS.escape(hwId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('palette-flash');
  el.addEventListener('animationend', () => el.classList.remove('palette-flash'), { once: true });
  return true;
}

/* -----------------------------------------------------------------------------
   Rescheduling by drag
   ----------------------------------------------------------------------------- */
const niceDay = s => s ? parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'no due date';

// `deadline` null clears it — undoing a drag that gave an undated assignment
// its first date. (undefined would be skipped by api.homework.update.)
async function setDeadline(hwId, deadline) {
  deadline = deadline || null;
  const cur = state.homework.find(h => h.id === hwId);
  // The time of day stays as it was; only the day moves.
  const upd = await api.homework.update(hwId, { deadline, deadlineMs: deadlineMsFor(deadline, cur?.deadlineTime) });
  const i = state.homework.findIndex(h => h.id === hwId);
  if (i !== -1) state.homework[i] = { ...state.homework[i], ...upd };
  renderSchedule();
  renderSummary();
}

async function reschedule(hwId, to) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw || hw.deadline === to) return;
  const from = hw.deadline;
  const desc = hw.description;
  // Move it on screen right away; put it back if the write fails.
  hw.deadline = to;
  renderSchedule(); renderSummary();
  try {
    await setDeadline(hwId, to);
  } catch (err) {
    hw.deadline = from;
    renderSchedule(); renderSummary();
    toast(`Error: ${err.message}`, 'error');
    return;
  }
  toast(`Moved "${desc}" to ${niceDay(to)}`, 'success');
  history.push({
    async undo() { await setDeadline(hwId, from); toast(`Moved "${desc}" back to ${niceDay(from)}`, 'info'); },
    async redo() { await setDeadline(hwId, to);   toast(`Moved "${desc}" to ${niceDay(to)}`, 'success'); },
  });
}

let drag = null;          // { id, el, x, y, ghost, over, pointerId }
let justDragged = false;

function dayUnder(x, y) {
  return document.elementFromPoint(x, y)?.closest('#calendar-container .cal-day') || null;
}

function onPointerDown(e) {
  const item = e.target.closest('.cal-item');
  // Touch scrolls the page; on a phone you change the date in the form instead.
  // Items in the Overdue / No due date lists drag onto a day too.
  if (!item || e.button !== 0 || e.pointerType === 'touch') return;
  drag = { id: item.dataset.hwId, el: item, x: e.clientX, y: e.clientY, ghost: null, over: null, pointerId: e.pointerId };
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    const r = drag.el.getBoundingClientRect();
    drag.ghost = drag.el.cloneNode(true);
    drag.ghost.classList.add('cal-ghost');
    drag.ghost.style.width = `${r.width}px`;
    drag.dx = drag.x - r.left; drag.dy = drag.y - r.top;
    document.body.appendChild(drag.ghost);
    drag.el.classList.add('cal-item--dragging');
    document.body.classList.add('is-dragging');
  }
  drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
  const day = dayUnder(e.clientX, e.clientY);
  if (day !== drag.over) {
    drag.over?.classList.remove('cal-day--drop');
    day?.classList.add('cal-day--drop');
    drag.over = day;
  }
}

function endDrag(e, cancelled = false) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  const d = drag; drag = null;
  if (!d.ghost) return;                        // it was a click, not a drag
  d.ghost.remove();
  d.el.classList.remove('cal-item--dragging');
  d.over?.classList.remove('cal-day--drop');
  document.body.classList.remove('is-dragging');
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  if (!cancelled && d.over) reschedule(d.id, d.over.dataset.date);
}

/* -----------------------------------------------------------------------------
   Wiring
   ----------------------------------------------------------------------------- */
function wireCalendar() {
  const root = $('calendar-container');

  document.querySelectorAll('.view-btn').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  updateToggle();

  root.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', e => endDrag(e));
  document.addEventListener('pointercancel', e => endDrag(e, true));
  document.addEventListener('keydown', e => {
    if (drag?.ghost && e.key === 'Escape') { e.stopPropagation(); endDrag(null, true); }
  }, true);

  root.addEventListener('click', e => {
    if (justDragged) return;
    const nav = e.target.closest('[data-cal-nav]');
    if (nav) { step(+nav.dataset.calNav); return; }
    const more = e.target.closest('[data-cal-more]');
    if (more) { anchor = parseYmd(more.dataset.calMore); setView('week'); return; }
    const item = e.target.closest('.cal-item');
    if (item) { openHwEditModal(item.dataset.hwId); return; }
    const day = e.target.closest('.cal-day');
    if (!day) return;
    // On a phone the month grid only has dots, so a tap opens that week to
    // read them. Everywhere else, an empty spot on a day starts a new
    // assignment due that day.
    if (view === 'month' && isPhone()) { anchor = parseYmd(day.dataset.date); setView('week'); return; }
    openHwModalPrefilled({ classId: defaultClassId(), deadline: day.dataset.date });
  });
}

export { currentView, hideCalendar, isCalendarView, renderCalendar, revealInCalendar, setView, step, updateToggle, wireCalendar };
