import { DAY_SHORT, describeRepeat, firstDue, presetToRepeat, repeatPreset } from './recurrence.js';

/* =============================================================================
   REPEAT IN THE ASSIGNMENT FORM

   A menu (Doesn't repeat / Every day / Every weekday / Every week / Every 2
   weeks / Every month), plus a row of weekday toggles for the two weekly
   choices, and a line underneath saying in words what was picked. Like the
   steps editor, nothing is saved from here: handleAddHomework reads it back
   with readRepeatInput().
   ============================================================================= */

const menu  = () => document.getElementById('hw-repeat');
const picker = () => document.getElementById('hw-repeat-days');
const hint  = () => document.getElementById('hw-repeat-hint');
const boxes = () => [...picker().querySelectorAll('input[type="checkbox"]')];

const pad   = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const deadlineValue = () => document.getElementById('hw-deadline').value || null;
const weekdayOf = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

function readRepeatInput(deadline = deadlineValue()) {
  const days = boxes().filter(b => b.checked).map(b => +b.value);
  return presetToRepeat(menu().value, { days, deadline: deadline || today() });
}

function sync() {
  const preset = menu().value;
  const weekly = preset === 'weekly' || preset === 'biweekly';
  picker().classList.toggle('hidden', !weekly);
  // Switching to a weekly choice starts from the due date's weekday.
  if (weekly && !boxes().some(b => b.checked)) {
    const day = weekdayOf(deadlineValue() || today());
    boxes().forEach(b => { b.checked = +b.value === day; });
  }

  const rule = readRepeatInput();
  hint().classList.toggle('hidden', !rule);
  if (!rule) return;
  let text = `${describeRepeat(rule)}. Ticking it off adds the next one.`;
  if (!deadlineValue()) {
    const [y, m, d] = firstDue(rule, today()).split('-').map(Number);
    text += ` With no due date picked, the first is due ${new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`;
  }
  hint().textContent = text;
}

function setRepeatInput(repeat) {
  menu().value = repeatPreset(repeat);
  const days = repeat?.freq === 'weekly' ? repeat.days : [];
  boxes().forEach(b => { b.checked = days.includes(+b.value); });
  sync();
}

function wireRepeatForm() {
  // Weekday toggles, Sunday first like the calendar.
  picker().innerHTML = DAY_SHORT.map((name, i) =>
    `<label class="weekday-opt" title="${name}"><input type="checkbox" value="${i}" aria-label="${name}"><span>${name[0]}</span></label>`).join('');
  menu().addEventListener('change', sync);
  picker().addEventListener('change', sync);
  document.getElementById('hw-deadline').addEventListener('change', sync);
}

export { readRepeatInput, setRepeatInput, wireRepeatForm };
