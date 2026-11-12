// Plan my day: what's in today's plan, in what order, and how long it takes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GUESS_MIN, heavyDays, planDay, remainingMin, whenDue } from '../../public/js/planner.js';

// Wednesday, Nov 11 2026, 3:00pm local (TZ is pinned by the test script).
const NOW = new Date(2026, 10, 11, 15, 0);
const hw = (id, fields = {}) => ({ id, description: id, completed: false, ...fields });
const plan = (list, budgetMin = 120) => planDay(list, { now: NOW, budgetMin });
const ids = p => p.items.map(i => i.hw.id);

describe('remainingMin', () => {
  test('the estimate, less ticked steps', () => {
    assert.equal(remainingMin(hw('a', { estimateMin: 60 })), 60);
    const steps = [{ done: true }, { done: false }, { done: false }, { done: true }];
    assert.equal(remainingMin(hw('a', { estimateMin: 60, subtasks: steps })), 30);
  });
  test('all steps ticked still leaves a few minutes', () => {
    assert.equal(remainingMin(hw('a', { estimateMin: 60, subtasks: [{ done: true }] })), 5);
  });
  test('no estimate → null', () => {
    assert.equal(remainingMin(hw('a')), null);
    assert.equal(remainingMin(hw('a', { subtasks: [{ done: false }] })), null);
  });
});

describe('whenDue', () => {
  const cases = [
    [{ deadline: '2026-11-10' }, 'overdue'],
    [{ deadline: '2026-11-11', deadlineTime: '09:00' }, 'overdue'],   // earlier today
    [{ deadline: '2026-11-11', deadlineTime: '23:00' }, 'today'],
    [{ deadline: '2026-11-11' }, 'today'],
    [{ deadline: '2026-11-12' }, 'tomorrow'],
    [{ deadline: '2026-11-13' }, 'later'],
    [{}, 'someday'],
  ];
  for (const [fields, want] of cases) {
    test(`${JSON.stringify(fields)} → ${want}`, () => assert.equal(whenDue(hw('x', fields), NOW), want));
  }
});

describe('planDay', () => {
  test('must-dos first: overdue, today, tomorrow; then soonest; undated last', () => {
    const p = plan([
      hw('someday', { estimateMin: 10 }),
      hw('later', { deadline: '2026-11-14', estimateMin: 10 }),
      hw('tomorrow', { deadline: '2026-11-12', estimateMin: 10 }),
      hw('today', { deadline: '2026-11-11', estimateMin: 10 }),
      hw('overdue', { deadline: '2026-11-09', estimateMin: 10 }),
      hw('soon', { deadline: '2026-11-13', estimateMin: 10 }),
    ]);
    assert.deepEqual(ids(p), ['overdue', 'today', 'tomorrow', 'soon', 'later', 'someday']);
    assert.deepEqual(p.items.map(i => i.must), [true, true, true, false, false, false]);
  });

  test('within a day: timed before untimed, then high priority first', () => {
    const p = plan([
      hw('untimed', { deadline: '2026-11-12', estimateMin: 10 }),
      hw('normal', { deadline: '2026-11-12', deadlineTime: '09:00', estimateMin: 10 }),
      hw('high', { deadline: '2026-11-12', deadlineTime: '09:00', estimateMin: 10, priority: 'high' }),
      hw('low', { deadline: '2026-11-12', deadlineTime: '09:00', estimateMin: 10, priority: 'low' }),
    ]);
    assert.deepEqual(ids(p), ['high', 'normal', 'low', 'untimed']);
  });

  test('fills the budget and stops; the first that does not fit gets a head start', () => {
    const p = plan([
      hw('a', { deadline: '2026-11-13', estimateMin: 60 }),
      hw('b', { deadline: '2026-11-14', estimateMin: 180 }),
      hw('c', { deadline: '2026-11-15', estimateMin: 10 }),
    ]);
    assert.deepEqual(ids(p), ['a', 'b']);
    assert.deepEqual(p.items[1], { ...p.items[1], minutes: 60, partial: true, totalMin: 180 });
    assert.equal(p.plannedMin, 120);
    assert.equal(p.leftOut, 1);   // c waits, even though it would fit
  });

  test('no head start shorter than 15 minutes', () => {
    const p = plan([hw('a', { deadline: '2026-11-13', estimateMin: 110 }), hw('b', { deadline: '2026-11-14', estimateMin: 60 })]);
    assert.deepEqual(ids(p), ['a']);
    assert.equal(p.leftOut, 1);
  });

  test('must-dos stay in past the budget, and say by how much', () => {
    const p = plan([
      hw('a', { deadline: '2026-11-11', estimateMin: 90 }),
      hw('b', { deadline: '2026-11-12', estimateMin: 90 }),
      hw('c', { deadline: '2026-11-20', estimateMin: 10 }),
    ]);
    assert.deepEqual(ids(p), ['a', 'b']);
    assert.equal(p.mustMin, 180);
    assert.equal(p.overBy, 60);
    assert.equal(p.items.some(i => i.partial), false);
  });

  test('no estimate counts as a guess', () => {
    const p = plan([hw('a', { deadline: '2026-11-12' })]);
    assert.equal(p.items[0].minutes, GUESS_MIN);
    assert.equal(p.items[0].guess, true);
  });

  test('ticked steps shrink the time', () => {
    const p = plan([hw('a', { deadline: '2026-11-12', estimateMin: 60, subtasks: [{ done: true }, { done: false }] })]);
    assert.equal(p.items[0].minutes, 30);
  });

  test('completed work is ignored; nothing to do is an empty plan', () => {
    const p = plan([hw('a', { deadline: '2026-11-11', completed: true })]);
    assert.deepEqual(p, { items: [], plannedMin: 0, budgetMin: 120, mustMin: 0, overBy: 0, leftOut: 0 });
  });
});

describe('heavyDays', () => {
  test('days past tomorrow with more due than a day holds', () => {
    const list = [
      hw('t1', { deadline: '2026-11-12', estimateMin: 300 }),    // tomorrow: in today's plan already
      hw('f1', { deadline: '2026-11-13', estimateMin: 90 }),
      hw('f2', { deadline: '2026-11-13', estimateMin: 60 }),
      hw('f3', { deadline: '2026-11-13' }),                      // no estimate: not counted
      hw('s1', { deadline: '2026-11-14', estimateMin: 120 }),    // exactly the budget: fine
      hw('x', { deadline: '2026-11-20', estimateMin: 500 }),     // past the week
      hw('done', { deadline: '2026-11-16', estimateMin: 500, completed: true }),
    ];
    assert.deepEqual(heavyDays(list, { now: NOW, budgetMin: 120 }), [{ date: '2026-11-13', totalMin: 150, count: 3 }]);
  });
});
