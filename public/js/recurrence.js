/* =============================================================================
   RECURRENCE — assignments that come back ("vocab quiz every Monday")

   Stored on an assignment as `repeat`, absent (or null) for a one-off:
     { freq: 'daily' }
     { freq: 'weekly', interval: 1 | 2, days: [1, 3] }   // 0 = Sunday … 6 = Saturday
     { freq: 'monthly', day: 15 }                        // day of the month, 1–31
     { freq: 'block', every: 2 }                         // every other school day

   'block' is for A/B block schedules: it counts school days (Mon–Fri) only,
   so a class on A days goes Mon, Wed, Fri, then Tue, Thu the next week. It
   can't know about holidays; moving one copy's due date shifts the rotation
   from there, since each copy counts from the one before.

   There's no background job to create future copies (Spark plan, no server),
   so a repeating assignment is one live document at a time: ticking it off
   creates the next one, due on nextDue(). A repeating assignment always has a
   due date — the rule counts from it.

   Pure, like duration.js, so tests/unit/recurrence.test.js runs it under Node.
   Dates are 'YYYY-MM-DD' local days, stepped with new Date(y, m, d + n), never
   by adding 24 hours (see calendar-dates.js for why).
   ============================================================================= */

const pad   = n => String(n).padStart(2, '0');
const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// Whole days from a to b, immune to clock changes in between.
const dayDiff = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
                                      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

const DAY_NAMES  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS   = [1, 2, 3, 4, 5];
const isYmd      = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isSchoolDay = d => d.getDay() !== 0 && d.getDay() !== 6;

/** A rule in its one canonical shape, or null when it isn't a rule. `deadline`
 *  fills in what the rule leaves out: the weekday for "every week", the day of
 *  the month for "every month". */
function normalizeRepeat(r, deadline = null) {
  if (!r || typeof r !== 'object') return null;
  const due = isYmd(deadline) ? parse(deadline) : null;
  if (r.freq === 'daily') return { freq: 'daily' };
  if (r.freq === 'weekly') {
    let days = Array.isArray(r.days) ? [...new Set(r.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    if (!days.length) days = due ? [due.getDay()] : [];
    if (!days.length) return null;
    return { freq: 'weekly', interval: r.interval === 2 ? 2 : 1, days };
  }
  if (r.freq === 'block') {
    return { freq: 'block', every: Number.isInteger(r.every) && r.every >= 2 && r.every <= 10 ? r.every : 2 };
  }
  if (r.freq === 'monthly') {
    const day = Number.isInteger(r.day) && r.day >= 1 && r.day <= 31 ? r.day : due?.getDate();
    return day ? { freq: 'monthly', day } : null;
  }
  return null;
}

// The first date strictly after `from` that the rule lands on.
function stepOnce(rule, from) {
  if (rule.freq === 'daily') return addDays(from, 1);
  if (rule.freq === 'block') {
    let d = from;
    for (let n = 0; n < rule.every;) { d = addDays(d, 1); if (isSchoolDay(d)) n++; }
    return d;
  }
  if (rule.freq === 'monthly') {
    // Clamped to short months, but always from the rule's own day, so a
    // "31st" assignment goes Jan 31 → Feb 28 → Mar 31 rather than drifting.
    const at = (y, m) => new Date(y, m, Math.min(rule.day, daysInMonth(y, m)));
    const same = at(from.getFullYear(), from.getMonth());
    return same > from ? same : at(from.getFullYear(), from.getMonth() + 1);
  }
  // Weekly: weeks count from the week `from` is in, so "every 2 weeks on Mon
  // & Wed" ticks through Mon, Wed, (skip a week), Mon, Wed.
  const startWeek = addDays(from, -from.getDay());
  for (let i = 1; i <= 7 * rule.interval + 7; i++) {
    const c = addDays(from, i);
    const week = Math.floor(dayDiff(startWeek, c) / 7);
    if (week % rule.interval === 0 && rule.days.includes(c.getDay())) return c;
  }
  return null;   // unreachable with a normalized rule
}

/**
 * When the next one is due, after the one due `deadline` is done. It's the
 * rule's next date after that deadline — but never in the past: finishing a
 * daily assignment three days late gives you one due today, not three overdue
 * ones to wade through.
 * @returns {string|null} 'YYYY-MM-DD'
 */
function nextDue(repeat, deadline, today) {
  const rule = normalizeRepeat(repeat, deadline);
  if (!rule || !isYmd(deadline)) return null;
  const floor = parse(today);
  let d = stepOnce(rule, parse(deadline));
  for (let guard = 0; d && d < floor && guard < 2000; guard++) d = stepOnce(rule, d);
  return d ? ymd(d) : null;
}

/** The first date on or after `today` the rule lands on — the due date for a
 *  repeating assignment that was saved without one. */
function firstDue(repeat, today) {
  // A block rotation has no fixed days to land on, so it starts on the next
  // school day (today, on a weekday); the user moves it if that's a B day.
  if (normalizeRepeat(repeat)?.freq === 'block') {
    let d = parse(today);
    while (!isSchoolDay(d)) d = addDays(d, 1);
    return ymd(d);
  }
  return nextDue(repeat, ymd(addDays(parse(today), -1)), today);
}

const ordinal = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
const listOf  = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} & ${xs.at(-1)}`;

/** "Every day", "Every weekday", "Every other school day", "Every Monday", "Every Mon, Wed & Fri",
 *  "Every 2 weeks on Tuesday", "Every month on the 15th". Empty for no rule. */
function describeRepeat(repeat) {
  const r = normalizeRepeat(repeat);
  if (!r) return '';
  if (r.freq === 'daily') return 'Every day';
  if (r.freq === 'monthly') return `Every month on the ${ordinal(r.day)}`;
  if (r.freq === 'block') return r.every === 2 ? 'Every other school day' : `Every ${r.every} school days`;
  const days = r.days.length === 1 ? DAY_NAMES[r.days[0]] : listOf(r.days.map(d => DAY_SHORT[d]));
  if (r.interval === 2) return `Every 2 weeks on ${days}`;
  if (r.days.join() === WEEKDAYS.join()) return 'Every weekday';
  return `Every ${days}`;
}

/* The form's Repeat menu, and how its choices map to rules. "weekdays" is just
   a weekly rule with Mon–Fri ticked, so it's recognized from the days. */
function repeatPreset(repeat) {
  const r = normalizeRepeat(repeat);
  if (!r) return '';
  if (r.freq === 'weekly') {
    if (r.interval === 2) return 'biweekly';
    return r.days.join() === WEEKDAYS.join() ? 'weekdays' : 'weekly';
  }
  return r.freq;
}

function presetToRepeat(preset, { days = [], deadline = null } = {}) {
  switch (preset) {
    case 'daily':    return { freq: 'daily' };
    case 'weekdays': return { freq: 'weekly', interval: 1, days: [...WEEKDAYS] };
    case 'weekly':   return normalizeRepeat({ freq: 'weekly', interval: 1, days }, deadline);
    case 'biweekly': return normalizeRepeat({ freq: 'weekly', interval: 2, days }, deadline);
    case 'monthly':  return normalizeRepeat({ freq: 'monthly' }, deadline);
    case 'block':    return { freq: 'block', every: 2 };
    default:         return null;
  }
}

export { DAY_SHORT, describeRepeat, firstDue, nextDue, normalizeRepeat, presetToRepeat, repeatPreset };
