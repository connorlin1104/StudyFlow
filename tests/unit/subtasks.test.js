// Subtasks: tidying a list before it's saved, progress, ticking, pasting.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUBTASKS, MAX_TEXT, cleanSubtasks, splitSteps, subtaskProgress, toggleSubtask } from '../../public/js/subtasks.js';

describe('cleanSubtasks', () => {
  test('trims, drops blanks, keeps order and done', () => {
    const out = cleanSubtasks([
      { id: 'a', text: '  read ch. 5 ', done: true },
      { id: 'b', text: '   ' },
      { id: 'c', text: 'problems 1-10' },
    ]);
    assert.deepEqual(out, [
      { id: 'a', text: 'read ch. 5', done: true },
      { id: 'c', text: 'problems 1-10', done: false },
    ]);
  });

  test('gives missing and repeated ids a fresh one', () => {
    const out = cleanSubtasks([{ text: 'one' }, { id: 'x', text: 'two' }, { id: 'x', text: 'three' }]);
    assert.equal(out.length, 3);
    assert.equal(new Set(out.map(s => s.id)).size, 3);
    assert.ok(out.every(s => typeof s.id === 'string' && s.id));
    assert.equal(out[1].id, 'x');
  });

  test('caps the number of steps and their length', () => {
    const many = Array.from({ length: MAX_SUBTASKS + 5 }, (_, i) => ({ text: `step ${i}` }));
    assert.equal(cleanSubtasks(many).length, MAX_SUBTASKS);
    assert.equal(cleanSubtasks([{ text: 'x'.repeat(MAX_TEXT + 50) }])[0].text.length, MAX_TEXT);
  });

  test('anything that is not a list becomes an empty one', () => {
    for (const bad of [null, undefined, 'steps', {}, 3]) assert.deepEqual(cleanSubtasks(bad), []);
    assert.deepEqual(cleanSubtasks([null, 5, { text: '' }]), []);
  });
});

describe('subtaskProgress', () => {
  test('counts done out of total', () => {
    assert.deepEqual(subtaskProgress({ subtasks: [{ done: true }, { done: false }, { done: true }] }), { done: 2, total: 3 });
  });
  test('null when there are no steps', () => {
    assert.equal(subtaskProgress({}), null);
    assert.equal(subtaskProgress({ subtasks: null }), null);
    assert.equal(subtaskProgress({ subtasks: [] }), null);
    assert.equal(subtaskProgress(undefined), null);
  });
});

describe('toggleSubtask', () => {
  const list = [{ id: 'a', text: 'A', done: false }, { id: 'b', text: 'B', done: true }];
  test('flips one step and leaves the original alone', () => {
    const out = toggleSubtask(list, 'a');
    assert.equal(out[0].done, true);
    assert.equal(out[1].done, true);
    assert.equal(list[0].done, false);
  });
  test('sets an explicit value', () => {
    assert.equal(toggleSubtask(list, 'b', true)[1].done, true);
    assert.equal(toggleSubtask(list, 'b', false)[1].done, false);
  });
  test('an unknown id changes nothing', () => {
    assert.deepEqual(toggleSubtask(list, 'zz'), list);
    assert.deepEqual(toggleSubtask(null, 'a'), []);
  });
});

describe('splitSteps', () => {
  test('one step per line, bullets and numbers stripped', () => {
    assert.deepEqual(splitSteps('- read ch. 5\n* outline\n• draft\n1. edit\n2) submit'), [
      { text: 'read ch. 5', done: false }, { text: 'outline', done: false }, { text: 'draft', done: false },
      { text: 'edit', done: false }, { text: 'submit', done: false },
    ]);
  });
  test('markdown checkboxes keep their tick', () => {
    assert.deepEqual(splitSteps('- [x] done one\n- [ ] not yet\n[X] also done'), [
      { text: 'done one', done: true }, { text: 'not yet', done: false }, { text: 'also done', done: true },
    ]);
  });
  test('blank lines are skipped, and a hyphen inside a step stays', () => {
    assert.deepEqual(splitSteps('\n  problems 1-10  \r\n\n'), [{ text: 'problems 1-10', done: false }]);
  });
  test('a number that starts a step is not a list marker', () => {
    assert.deepEqual(splitSteps('3 pages of notes'), [{ text: '3 pages of notes', done: false }]);
  });
  test('nothing in, nothing out', () => {
    assert.deepEqual(splitSteps(''), []);
    assert.deepEqual(splitSteps(null), []);
  });
});
