/* =============================================================================
   PLAN MY DAY — what to work on today, in what order, and how long it'll take

   Pure (no DOM, no Firebase), like duration.js, so tests/unit/planner.test.js
   runs it under Node. today.js draws what this returns.

   The rules, in order:
     1. Must-dos come first and are always in, budget or not: overdue work
        (oldest first), then what's due today, then what's due tomorrow —
        homework due tomorrow is tonight's homework.
     2. Then the rest, soonest due first, undated last, filling whatever's
        left of the daily budget. The first thing that doesn't fit gets the
        leftover time as a head start ("45m of 3h") if there's at least
        MIN_SLICE of it, and the plan stops there — it doesn't skip ahead to
        something smaller and due later.
     3. Ties go to priority, high before low (priorityRank, like everywhere
        else).
   Time is the estimate minus the share of steps already ticked. Assignments
   without an estimate count as GUESS_MIN and are marked as a guess, so the
   total is honest about how much of it is made up.
   ============================================================================= */

import { priorityRank } from './state.js';
import { subtaskProgress } from './subtasks.js';

const DEFAULT_BUDGET = 120;   // minutes a day, until someone picks their own
const GUESS_MIN      = 30;
const MIN_SLICE      = 15;

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Minutes of work left on an assignment, or null with no estimate. Ticked
 *  steps take their share off; a fully ticked one still needs a few minutes to
 *  wrap up and hand in. */
function remainingMin(hw) {
  if (!(hw?.estimateMin > 0)) return null;
  const p = subtaskProgress(hw);
  if (!p) return hw.estimateMin;
  return Math.max(5, Math.round(hw.estimateMin * (1 - p.done / p.total)));
}

/** Why it's on the list: 'overdue', 'today', 'tomorrow', 'later' (dated) or
 *  'someday' (no due date). Due earlier today and past its time is overdue. */
function whenDue(hw, now) {
  if (!hw.deadline) return 'someday';
  const today = ymd(now);
  if (hw.deadline < today) return 'overdue';
  if (hw.deadline === today) return hw.deadlineTime && hw.deadlineTime <= hhmm(now) ? 'overdue' : 'today';
  if (hw.deadline === ymd(addDays(now, 1))) return 'tomorrow';
  return 'later';
}

const RANK = { overdue: 0, today: 1, tomorrow: 2, later: 3, someday: 4 };
const MUST = new Set(['overdue', 'today', 'tomorrow']);

function compare(a, b) {
  return (RANK[a.reason] - RANK[b.reason])
    || (a.hw.deadline || '').localeCompare(b.hw.deadline || '')
    // An untimed deadline means the end of the day, so it sorts after timed ones.
    || (a.hw.deadlineTime || '99').localeCompare(b.hw.deadlineTime || '99')
    || (priorityRank(a.hw) - priorityRank(b.hw))
    || ((a.hw.order ?? 9999) - (b.hw.order ?? 9999));
}

/**
 * @param {Array} homework   assignments (completed ones are ignored)
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {number} [opts.budgetMin]   minutes available today
 * @returns {{
 *   items: Array<{ hw, reason, minutes, guess: boolean, partial: boolean, must: boolean }>,
 *   plannedMin: number,   // what the items add up to
 *   budgetMin: number,
 *   mustMin: number,      // what the must-dos alone add up to
 *   overBy: number,       // minutes the must-dos run past the budget, else 0
 *   leftOut: number,      // assignments not in today's plan
 * }}
 */
function planDay(homework, { now = new Date(), budgetMin = DEFAULT_BUDGET } = {}) {
  const candidates = homework
    .filter(hw => !hw.completed)
    .map(hw => {
      const left = remainingMin(hw);
      const reason = whenDue(hw, now);
      return { hw, reason, minutes: left ?? GUESS_MIN, guess: left == null, partial: false, must: MUST.has(reason) };
    })
    .sort(compare);

  const items = [];
  let used = 0;
  for (const c of candidates) {
    if (c.must || used + c.minutes <= budgetMin) {
      items.push(c);
      used += c.minutes;
      continue;
    }
    const room = budgetMin - used;
    if (room >= MIN_SLICE) {
      items.push({ ...c, minutes: room, partial: true, totalMin: c.minutes });
      used += room;
    }
    break;
  }

  const mustMin = items.filter(i => i.must).reduce((s, i) => s + i.minutes, 0);
  return {
    items,
    plannedMin: used,
    budgetMin,
    mustMin,
    overBy: Math.max(0, mustMin - budgetMin),
    leftOut: candidates.length - items.length,
  };
}

/**
 * Days in the coming week with more work due than fits in one day's budget —
 * the "Thursday: 4h 30m" warning. Counts only real estimates (a pile of
 * guesses isn't worth a warning), and starts the day after tomorrow, since
 * today's and tomorrow's work is already in today's plan.
 * @returns {Array<{ date: string, totalMin: number, count: number }>}
 */
function heavyDays(homework, { now = new Date(), budgetMin = DEFAULT_BUDGET, days = 7 } = {}) {
  const out = [];
  for (let i = 2; i <= days; i++) {
    const date = ymd(addDays(now, i));
    const due = homework.filter(hw => !hw.completed && hw.deadline === date);
    const totalMin = due.reduce((s, hw) => s + (remainingMin(hw) ?? 0), 0);
    if (totalMin > budgetMin) out.push({ date, totalMin, count: due.length });
  }
  return out;
}

export { DEFAULT_BUDGET, GUESS_MIN, MIN_SLICE, heavyDays, planDay, remainingMin, whenDue };
