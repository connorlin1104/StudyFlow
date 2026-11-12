// Repeating assignments: when the next one is due, and how a rule reads.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeRepeat, firstDue, nextDue, normalizeRepeat, presetToRepeat, repeatPreset } from '../../public/js/recurrence.js';

// Nov 2026: Sun 1, Mon 2 … Wed 11 is "today" in most cases below.
const TODAY = '2026-11-11';
const weekly = (days, interval = 1) => ({ freq: 'weekly', interval, days });

describe('normalizeRepeat', () => {
  test('fills in from the deadline what the rule leaves out', () => {
    assert.deepEqual(normalizeRepeat({ freq: 'weekly' }, '2026-11-16'), weekly([1]));
    assert.deepEqual(normalizeRepeat({ freq: 'monthly' }, '2026-11-30'), { freq: 'monthly', day: 30 });
  });
  test('tidies days and interval', () => {
    assert.deepEqual(normalizeRepeat({ freq: 'weekly', days: [5, 1, 1, 9, -1, 'x'], interval: 7 }), weekly([1, 5]));
    assert.deepEqual(normalizeRepeat({ freq: 'weekly', days: [3], interval: 2 }), weekly([3], 2));
  });
  test('not a rule → null', () => {
    for (const bad of [null, undefined, 'weekly', {}, { freq: 'yearly' }, { freq: 'weekly' }, { freq: 'monthly' }]) {
      assert.equal(normalizeRepeat(bad), null, JSON.stringify(bad));
    }
  });
});

describe('nextDue', () => {
  test('daily: the day after', () => {
    assert.equal(nextDue({ freq: 'daily' }, '2026-11-11', TODAY), '2026-11-12');
  });
  test('weekly on one day: a week later', () => {
    assert.equal(nextDue(weekly([3]), '2026-11-11', TODAY), '2026-11-18');
  });
  test('weekly on several days: the next of them', () => {
    const mwf = weekly([1, 3, 5]);
    assert.equal(nextDue(mwf, '2026-11-11', TODAY), '2026-11-13');   // Wed → Fri
    assert.equal(nextDue(mwf, '2026-11-13', TODAY), '2026-11-16');   // Fri → Mon
  });
  test('weekdays skip the weekend', () => {
    assert.equal(nextDue(weekly([1, 2, 3, 4, 5]), '2026-11-13', TODAY), '2026-11-16');
  });
  test('every 2 weeks', () => {
    assert.equal(nextDue(weekly([3], 2), '2026-11-11', TODAY), '2026-11-25');
    // Mon & Wed every other week: Mon → Wed in the same week, then skip a week
    assert.equal(nextDue(weekly([1, 3], 2), '2026-11-09', '2026-11-01'), '2026-11-11');
    assert.equal(nextDue(weekly([1, 3], 2), '2026-11-11', TODAY), '2026-11-23');
  });
  test('monthly keeps its day through short months', () => {
    const m31 = { freq: 'monthly', day: 31 };
    assert.equal(nextDue(m31, '2027-01-31', '2027-01-01'), '2027-02-28');
    assert.equal(nextDue(m31, '2027-02-28', '2027-01-01'), '2027-03-31');
    assert.equal(nextDue({ freq: 'monthly', day: 15 }, '2026-12-15', TODAY), '2027-01-15');
  });
  test('a weekly deadline off its own days moves onto them', () => {
    assert.equal(nextDue(weekly([1]), '2026-11-11', TODAY), '2026-11-16');   // Wed → next Mon
  });
  test('never lands in the past when it is finished late', () => {
    assert.equal(nextDue({ freq: 'daily' }, '2026-11-01', TODAY), TODAY);
    assert.equal(nextDue(weekly([1]), '2026-10-05', TODAY), '2026-11-16');
    assert.equal(nextDue({ freq: 'monthly', day: 1 }, '2026-01-01', TODAY), '2026-12-01');
  });
  test('across the clocks going back (Nov 1 2026)', () => {
    assert.equal(nextDue({ freq: 'daily' }, '2026-10-31', '2026-10-01'), '2026-11-01');
    assert.equal(nextDue(weekly([6]), '2026-10-31', '2026-10-01'), '2026-11-07');
  });
  test('no rule or no deadline → null', () => {
    assert.equal(nextDue(null, '2026-11-11', TODAY), null);
    assert.equal(nextDue({ freq: 'daily' }, null, TODAY), null);
  });
});

describe('firstDue', () => {
  test('today when the rule lands on today, else the next day it does', () => {
    assert.equal(firstDue({ freq: 'daily' }, TODAY), TODAY);
    assert.equal(firstDue(weekly([3]), TODAY), TODAY);
    assert.equal(firstDue(weekly([1]), TODAY), '2026-11-16');
    assert.equal(firstDue({ freq: 'monthly', day: 5 }, TODAY), '2026-12-05');
  });
});

describe('describeRepeat', () => {
  const cases = [
    [{ freq: 'daily' }, 'Every day'],
    [weekly([1]), 'Every Monday'],
    [weekly([1, 3, 5]), 'Every Mon, Wed & Fri'],
    [weekly([2, 4]), 'Every Tue & Thu'],
    [weekly([1, 2, 3, 4, 5]), 'Every weekday'],
    [weekly([2], 2), 'Every 2 weeks on Tuesday'],
    [{ freq: 'monthly', day: 1 }, 'Every month on the 1st'],
    [{ freq: 'monthly', day: 22 }, 'Every month on the 22nd'],
    [{ freq: 'monthly', day: 13 }, 'Every month on the 13th'],
    [null, ''],
  ];
  for (const [rule, want] of cases) test(want || '(none)', () => assert.equal(describeRepeat(rule), want));
});

describe('form presets', () => {
  test('preset → rule', () => {
    assert.deepEqual(presetToRepeat('weekdays'), weekly([1, 2, 3, 4, 5]));
    assert.deepEqual(presetToRepeat('weekly', { days: [2, 4] }), weekly([2, 4]));
    assert.deepEqual(presetToRepeat('weekly', { deadline: '2026-11-13' }), weekly([5]));
    assert.deepEqual(presetToRepeat('biweekly', { days: [1] }), weekly([1], 2));
    assert.deepEqual(presetToRepeat('monthly', { deadline: '2026-11-20' }), { freq: 'monthly', day: 20 });
    assert.equal(presetToRepeat(''), null);
  });
  test('rule → preset, round trip', () => {
    for (const p of ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']) {
      assert.equal(repeatPreset(presetToRepeat(p, { days: [3], deadline: TODAY })), p);
    }
    assert.equal(repeatPreset(null), '');
  });
});
