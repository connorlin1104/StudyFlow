import { esc } from './utils.js';
import { MAX_SUBTASKS, MAX_TEXT, cleanSubtasks, splitSteps, subtaskId } from './subtasks.js';

/* =============================================================================
   STEPS IN THE ASSIGNMENT FORM

   An editable checklist: each row is a tick box, the step's text and a remove
   button, with a "new step" box under it. Nothing is saved from here — the
   form reads the rows back with readFormSubtasks() when it's submitted.

     Enter in the new-step box      adds it (a multi-line paste adds each line)
     Enter in a step                jumps to the new-step box
     Backspace in an empty step     removes it
     Alt+↑ / Alt+↓ in a step        moves it
   ============================================================================= */

const list   = () => document.getElementById('hw-steps');
const newBox = () => document.getElementById('hw-step-new');

function rowHtml({ id, text, done }) {
  return `<li class="step-edit" data-id="${esc(id)}">
    <input type="checkbox" class="step-edit-check" aria-label="Done"${done ? ' checked' : ''}>
    <input type="text" class="step-edit-text" value="${esc(text)}" maxlength="${MAX_TEXT}" aria-label="Step" autocomplete="off">
    <button type="button" class="step-edit-remove" aria-label="Remove step" title="Remove step">&#x2715;</button>
  </li>`;
}

function rowCount() { return list().children.length; }

// The new-step box stops taking steps at the cap rather than silently
// dropping whatever goes past it on save.
function syncNewBox() {
  const full = rowCount() >= MAX_SUBTASKS;
  newBox().disabled    = full;
  newBox().placeholder = full ? `That's the most steps one assignment can have (${MAX_SUBTASKS})`
                              : rowCount() ? 'Add another step' : 'Add a step, then press Enter';
}

function setFormSubtasks(steps) {
  list().innerHTML = cleanSubtasks(steps).map(rowHtml).join('');
  newBox().value = '';
  syncNewBox();
}

function addSteps(steps) {
  const room = MAX_SUBTASKS - rowCount();
  const html = steps.slice(0, Math.max(0, room)).map(s => rowHtml({ id: subtaskId(), text: s.text.slice(0, MAX_TEXT), done: s.done }));
  list().insertAdjacentHTML('beforeend', html.join(''));
  syncNewBox();
}

/** The rows as they stand, plus anything still typed in the new-step box —
 *  hitting Save with a step half-entered shouldn't throw it away. */
function readFormSubtasks() {
  const rows = [...list().querySelectorAll('.step-edit')].map(li => ({
    id:   li.dataset.id,
    text: li.querySelector('.step-edit-text').value,
    done: li.querySelector('.step-edit-check').checked,
  }));
  const pending = splitSteps(newBox().value).map(s => ({ ...s, id: subtaskId() }));
  return cleanSubtasks([...rows, ...pending]);
}

function focusText(li) {
  const input = li?.querySelector('.step-edit-text');
  if (!input) { newBox().focus(); return; }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function wireSubtaskForm() {
  newBox().addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();                      // never submits the form
    const steps = splitSteps(newBox().value);
    if (!steps.length) return;
    addSteps(steps);
    newBox().value = '';
  });

  // A pasted list becomes one step per line instead of one long line.
  newBox().addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/\n/.test(text.trim())) return;
    e.preventDefault();
    addSteps(splitSteps(text));
  });

  list().addEventListener('click', e => {
    const remove = e.target.closest('.step-edit-remove');
    if (!remove) return;
    const li   = remove.closest('.step-edit');
    const next = li.nextElementSibling ?? li.previousElementSibling;
    li.remove();
    syncNewBox();
    focusText(next);
  });

  list().addEventListener('keydown', e => {
    const input = e.target.closest('.step-edit-text');
    if (!input || e.isComposing) return;
    const li = input.closest('.step-edit');
    if (e.key === 'Enter') {
      e.preventDefault();
      newBox().focus();
    } else if (e.key === 'Backspace' && !input.value) {
      e.preventDefault();
      const prev = li.previousElementSibling;
      li.remove();
      syncNewBox();
      focusText(prev);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const other = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
      if (!other) return;
      if (e.key === 'ArrowUp') other.before(li); else other.after(li);
      focusText(li);
    }
  });
}

export { readFormSubtasks, setFormSubtasks, wireSubtaskForm };
