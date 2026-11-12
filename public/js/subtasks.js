/* =============================================================================
   SUBTASKS — the steps inside an assignment ("read ch. 5", "do the problems")

   Stored on an assignment as `subtasks: [{ id, text, done }]`, in order, and
   absent (or null, once cleared) when there are none. The ids only have to be
   unique within one assignment — they let a tick on the card find its step
   even if the list was edited elsewhere in the meantime. Pure, like
   duration.js, so tests/unit/subtasks.test.js runs it under Node.
   ============================================================================= */

const MAX_SUBTASKS = 50;
const MAX_TEXT     = 200;

function subtaskId() {
  return `st-${Math.random().toString(36).slice(2, 10)}`;
}

/** Tidy a list before it's saved: trims text, drops blank steps, gives every
 *  step a unique id, and caps the length. Always returns an array. */
function cleanSubtasks(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out  = [];
  for (const s of list) {
    const text = String(s?.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    let id = typeof s.id === 'string' && s.id ? s.id : subtaskId();
    while (seen.has(id)) id = subtaskId();
    seen.add(id);
    out.push({ id, text, done: !!s.done });
    if (out.length === MAX_SUBTASKS) break;
  }
  return out;
}

/** { done, total } for an assignment's steps, or null when it has none. */
function subtaskProgress(hw) {
  const list = Array.isArray(hw?.subtasks) ? hw.subtasks : [];
  if (!list.length) return null;
  return { done: list.filter(s => s.done).length, total: list.length };
}

/** A copy of the list with one step ticked or unticked. */
function toggleSubtask(list, id, done) {
  return (list || []).map(s => s.id === id ? { ...s, done: done ?? !s.done } : s);
}

/**
 * Pasted text → steps, one per line. Leading bullets and numbering are
 * stripped, and a "[x]" checkbox (as copied from a markdown list) comes in
 * ticked:
 *   "- read ch. 5\n2. [x] outline" → [{text:'read ch. 5'}, {text:'outline', done:true}]
 */
function splitSteps(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => {
      let s = line.trim().replace(/^(?:[-*•‣◦]|\d+[.)])\s+/, '');
      let done = false;
      const box = s.match(/^\[([ xX]?)\]\s*/);
      if (box) { done = box[1].toLowerCase() === 'x'; s = s.slice(box[0].length); }
      return { text: s.trim(), done };
    })
    .filter(s => s.text);
}

export { MAX_SUBTASKS, MAX_TEXT, cleanSubtasks, splitSteps, subtaskId, subtaskProgress, toggleSubtask };
