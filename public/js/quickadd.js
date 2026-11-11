/* =============================================================================
   QUICK-ADD PARSER

   Turns one line like "Bio lab report fri 3pm" into the fields of the
   assignment form: { description, classId, deadline, deadlineTime }.

   Pure on purpose — no DOM, no Firebase, no shared state — so it runs under
   Node's test runner (tests/unit/quickadd.test.js). The caller passes the
   groups and "now" in. Nothing here saves anything: the palette shows what was
   understood and opens the normal assignment form pre-filled, so a misread is
   always caught before it lands on the board.
   ============================================================================= */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
// Words that lead into a date or time and should disappear with it:
// "due fri", "on nov 20", "by 3pm", "at noon".
const LEAD = '(?:(?:due|on|by|at|@)\\s+)*';

// Short words that would otherwise prefix-match group names ("the" → Theater).
const NOT_GROUP_HINTS = new Set(['the', 'and', 'for', 'due', 'with', 'from', 'into', 'about', 'this',
  'that', 'next', 'page', 'pages', 'read', 'study', 'test', 'quiz', 'essay', 'project', 'work', 'notes']);

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// A month/day with no year means the next time that date comes around.
function upcoming(today, month, day, year) {
  if (year != null) {
    const d = new Date(year < 100 ? 2000 + year : year, month, day);
    return d.getMonth() === month ? d : null;           // rejects Feb 30 etc.
  }
  let d = new Date(today.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d < today) d = new Date(today.getFullYear() + 1, month, day);
  return d;
}

/* Each rule finds one kind of date or time. They run in order and the first
   match of each kind wins; the matched text is cut out of the description. */
const TIME_RULES = [
  { re: new RegExp(`\\b${LEAD}(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm|a|p)\\b`, 'i'), get: m => {
    const h = +m[1]; if (h < 1 || h > 12) return null;
    const pm = m[3][0].toLowerCase() === 'p';
    return `${pad((h % 12) + (pm ? 12 : 0))}:${m[2] || '00'}`;
  } },
  { re: new RegExp(`\\b${LEAD}([01]?\\d|2[0-3]):([0-5]\\d)\\b`, 'i'), get: m => `${pad(+m[1])}:${m[2]}` },
  { re: new RegExp(`\\b${LEAD}noon\\b`, 'i'),     get: () => '12:00' },
  // "Due midnight" means the end of that day, not the start of it.
  { re: new RegExp(`\\b${LEAD}midnight\\b`, 'i'), get: () => '23:59' },
];

const DATE_RULES = [
  { re: new RegExp(`\\b${LEAD}(today|tonight)\\b`, 'i'), get: (m, t) => t },
  { re: new RegExp(`\\b${LEAD}(tomorrow|tmrw?|tmw)\\b`, 'i'), get: (m, t) => addDays(t, 1) },
  { re: new RegExp(`\\b${LEAD}in\\s+(\\d{1,3})\\s+days?\\b`, 'i'), get: (m, t) => addDays(t, +m[1]) },
  { re: new RegExp(`\\b${LEAD}(?:in\\s+a\\s+week|next\\s+week)\\b`, 'i'), get: (m, t) => addDays(t, 7) },
  // "nov 20", "November 20th", "nov 20, 2027"
  { re: new RegExp(`\\b${LEAD}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
    get: (m, t) => upcoming(t, MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2], m[3] ? +m[3] : null) },
  // "20 nov", "20th of November"
  { re: new RegExp(`\\b${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'i'),
    get: (m, t) => upcoming(t, MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1], m[3] ? +m[3] : null) },
  // "11/20", "11/20/27" — US order, month first
  { re: new RegExp(`\\b${LEAD}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?\\b`, 'i'),
    get: (m, t) => (+m[1] >= 1 && +m[1] <= 12) ? upcoming(t, +m[1] - 1, +m[2], m[3] ? +m[3] : null) : null },
  // "fri", "next friday". Always the next one after today — on a Friday, "fri"
  // means a week out, since "today" says today. "next" changes nothing.
  // A weekday written in capitals ("SAT prep") is an acronym, not a date.
  { re: new RegExp(`\\b${LEAD}(?:next\\s+)?${WEEKDAY_RE}\\b`, 'i'), get: (m, t) => {
    const word = m[1];
    if (word.length <= 3 && word === word.toUpperCase()) return null;
    const target = WEEKDAYS[word.slice(0, 3).toLowerCase()];
    return addDays(t, ((target - t.getDay() + 6) % 7) + 1);
  } },
];

// Find the first rule that matches and yields a value; returns the value and
// the text with that span cut out.
function take(text, rules, today) {
  for (const { re, get } of rules) {
    const g = new RegExp(re.source, re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const value = get(m, today);
      if (value == null) continue;
      return { value, text: text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length) };
    }
  }
  return { value: null, text };
}

const words = s => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/* Which group does the text mention? A whole group name ("AP Bio") beats a
   prefix of one of its words ("bio" → "Biology"). Ties go to the space being
   looked at, then to the shorter name. The group word is only removed from the
   description when it sits at the start or end ("Bio lab report"), not when
   it's part of the sentence ("study for history test"). */
function findGroup(text, groups, activeTabId) {
  const textWords = words(text);
  if (!textWords.length) return null;
  let best = null;
  for (const g of groups) {
    const nameWords = words(g.name || '');
    if (!nameWords.length) continue;
    let score = 0, span = null;
    // Whole name as consecutive words
    for (let i = 0; i + nameWords.length <= textWords.length; i++) {
      if (nameWords.every((w, j) => textWords[i + j] === w)) {
        score = 100 + nameWords.join(' ').length; span = [i, i + nameWords.length]; break;
      }
    }
    // A single word that begins one of the group's words
    if (!score) {
      for (let i = 0; i < textWords.length; i++) {
        const w = textWords[i];
        if (w.length < 3 || NOT_GROUP_HINTS.has(w) || /^\d+$/.test(w)) continue;
        if (nameWords.some(n => n.startsWith(w))) { score = 10 + w.length; span = [i, i + 1]; break; }
      }
    }
    if (!score) continue;
    if (g.tabId === activeTabId) score += 0.5;
    if (!best || score > best.score || (score === best.score && g.name.length < best.group.name.length)) {
      best = { group: g, score, span };
    }
  }
  if (!best) return null;
  const [a, b] = best.span;
  const atEdge = a === 0 || b === textWords.length;
  return { group: best.group, removeSpan: atEdge ? best.span : null };
}

// Remove the a-th..b-th words (as counted by words()) from the original text,
// keeping everything else exactly as typed.
function cutWords(text, a, b) {
  const re = /[\p{L}\p{N}]+/gu;
  let i = 0, start = null, end = null;
  for (const m of text.matchAll(re)) {
    if (i === a) start = m.index;
    if (i === b - 1) { end = m.index + m[0].length; break; }
    i++;
  }
  return start == null || end == null ? text : text.slice(0, start) + ' ' + text.slice(end);
}

function tidy(s) {
  return s.replace(/\s+/g, ' ')
          .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '')
          .replace(/\s+(due|on|by|at|for)$/i, '')
          .replace(/^(due|for)\s+/i, '')
          .trim();
}

/**
 * @param {string} input   what the user typed
 * @param {object} opts
 * @param {Array<{id,name,tabId}>} opts.groups
 * @param {string} [opts.activeTabId]
 * @param {Date}   [opts.now]
 * @returns {{ description: string, classId: string|null, deadline: string|null, deadlineTime: string|null }}
 */
function parseQuickAdd(input, { groups = [], activeTabId = null, now = new Date() } = {}) {
  const today = startOfDay(now);
  let text = ` ${input || ''} `;

  const time = take(text, TIME_RULES, today);  text = time.text;
  const date = take(text, DATE_RULES, today);  text = date.text;

  let deadline = date.value ? ymd(date.value) : null;
  const deadlineTime = time.value;
  // A time with no date: today if that time is still ahead, otherwise tomorrow.
  if (deadlineTime && !deadline) {
    const [h, m] = deadlineTime.split(':').map(Number);
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
    deadline = ymd(at > now ? today : addDays(today, 1));
  }

  const found = findGroup(text, groups, activeTabId);
  if (found?.removeSpan) text = cutWords(text, ...found.removeSpan);

  return {
    description: tidy(text),
    classId: found ? found.group.id : null,
    deadline,
    deadlineTime,
  };
}

export { parseQuickAdd };
