/* =============================================================================
   CALENDAR DATE MATH

   The calendar view's arithmetic: which days a week or month shows, which
   assignments land on which day, and what a moved deadline becomes. Pure (no
   DOM, no Firebase), so tests/unit/calendar.test.js runs it under Node.

   Dates are local calendar days throughout. Days are stepped with
   new Date(y, m, d + n), never by adding 24 hours, because the days the clocks
   change are 23 and 25 hours long.
   ============================================================================= */

const pad = n => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' in local time. */
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM-DD' → local midnight. */
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const addDays   = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** The Sunday on or before d. */
const weekStart = d => addDays(d, -d.getDay());

/** The 7 days, Sunday to Saturday, of the week containing d. */
function weekDays(d) {
  const start = weekStart(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Whole weeks covering d's month, from the Sunday before the 1st to the
    Saturday after the last day: 4 to 6 rows of 7 dates. */
function monthGrid(d) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last  = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const weeks = [];
  for (let s = weekStart(first); s <= last; s = addDays(s, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(s, i)));
  }
  return weeks;
}

/** Visible range for a view, as inclusive 'YYYY-MM-DD' strings. */
function viewRange(view, anchor) {
  if (view === 'week') {
    const days = weekDays(anchor);
    return { from: ymd(days[0]), to: ymd(days[6]) };
  }
  const weeks = monthGrid(anchor);
  return { from: ymd(weeks[0][0]), to: ymd(weeks.at(-1)[6]) };
}

/** Step the anchor one week or one month. Months land on the 1st, so stepping
    from Jan 31 doesn't skip February. */
const shiftAnchor = (view, anchor, dir) => view === 'week' ? addDays(anchor, 7 * dir) : addMonths(anchor, dir);

/** "Nov 8 – 14, 2026", "Nov 29 – Dec 5, 2026", "Dec 27, 2026 – Jan 2, 2027", "November 2026". */
function rangeLabel(view, anchor) {
  if (view !== 'week') return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const [a, b] = [weekStart(anchor), addDays(weekStart(anchor), 6)];
  const mon = d => d.toLocaleDateString('en-US', { month: 'short' });
  if (a.getFullYear() !== b.getFullYear()) {
    return `${mon(a)} ${a.getDate()}, ${a.getFullYear()} – ${mon(b)} ${b.getDate()}, ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) return `${mon(a)} ${a.getDate()} – ${mon(b)} ${b.getDate()}, ${b.getFullYear()}`;
  return `${mon(a)} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
}

// Within a day: timed work in time order, then "sometime that day" — which
// means 23:59, same as deadlineValue() in state.js.
const byTime = (a, b) => (a.deadlineTime || '23:59').localeCompare(b.deadlineTime || '23:59')
                      || (a.description || '').localeCompare(b.description || '');

/**
 * Sort pending assignments into the visible days.
 * @returns {{ days: Map<string, object[]>, overdue: object[], undated: object[] }}
 *   days     every date in [from, to] → that day's assignments (possibly empty)
 *   overdue  due before `today` and before the visible range, so not on screen
 *   undated  no deadline at all
 */
function bucket(homework, { from, to, today }) {
  const days = new Map();
  for (let d = parseYmd(from); ymd(d) <= to; d = addDays(d, 1)) days.set(ymd(d), []);
  const overdue = [], undated = [];
  for (const hw of homework) {
    if (hw.completed) continue;
    if (!hw.deadline) undated.push(hw);
    else if (days.has(hw.deadline)) days.get(hw.deadline).push(hw);
    else if (hw.deadline < from && hw.deadline < today) overdue.push(hw);
  }
  for (const list of days.values()) list.sort(byTime);
  overdue.sort((a, b) => a.deadline.localeCompare(b.deadline) || byTime(a, b));
  return { days, overdue, undated };
}

/** The deadlineMs the reminder sender reads: the due time, or 23:59 for a bare
    date. handlers.js and the calendar's drag-to-reschedule both use this, so
    the two can't drift apart. */
function deadlineMsFor(deadline, deadlineTime) {
  if (!deadline) return null;
  return new Date(`${deadline}T${deadlineTime || '23:59'}:00`).getTime();
}

export {
  addDays, bucket, deadlineMsFor, monthGrid, parseYmd, rangeLabel, shiftAnchor, viewRange, weekDays, weekStart, ymd,
};
