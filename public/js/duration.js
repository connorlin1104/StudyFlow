/* =============================================================================
   DURATIONS — time estimates ("about 45 minutes")

   Stored on an assignment as `estimateMin`, a whole number of minutes, and
   absent when there's no estimate. Pure, like quickadd.js, so
   tests/unit/duration.test.js runs it under Node.
   ============================================================================= */

// Longest estimate accepted: a full day. Anything bigger is almost certainly
// a typo ("90h" for "90m"), and a form error beats a silly number on a card.
const MAX_MIN = 24 * 60;

/**
 * What a person types → minutes, or null when it isn't a duration.
 *   "45", "45m", "45 min", "45 minutes"  → 45   (a bare number means minutes)
 *   "1h", "1 hr", "2 hours"              → 60, 120
 *   "1.5h", "1,5h"                       → 90
 *   "1h30", "1h 30m", "1 hr 30 min"      → 90
 *   "1:30"                               → 90
 */
function parseDuration(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  let m;
  let min = null;
  if ((m = s.match(/^(\d+):([0-5]\d)$/))) {
    min = +m[1] * 60 + +m[2];
  } else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/))) {
    min = Math.round(+m[1] * 60) + (m[2] ? +m[2] : 0);
  } else if ((m = s.match(/^(\d+)\s*(?:m|mins?|minutes?)?$/))) {
    min = +m[1];
  }
  return min && min > 0 && min <= MAX_MIN ? min : null;
}

/** Minutes → "45m", "1h", "1h 30m". Empty for nothing. */
function formatDuration(min) {
  if (!min || min <= 0) return '';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Sum of the estimates on a list of assignments; unestimated ones count 0. */
function totalEstimate(homework) {
  return homework.reduce((sum, hw) => sum + (hw.estimateMin > 0 ? hw.estimateMin : 0), 0);
}

export { MAX_MIN, formatDuration, parseDuration, totalEstimate };
