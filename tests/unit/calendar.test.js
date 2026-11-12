// Date math behind the week and month views.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucket, deadlineMsFor, monthGrid, parseYmd, rangeLabel, shiftAnchor, viewRange, weekDays, ymd,
} from '../../public/js/calendar-dates.js';

const D = s => parseYmd(s);

describe('weeks', () => {
  test('run Sunday to Saturday around any day', () => {
    assert.deepEqual(weekDays(D('2026-11-11')).map(ymd),
      ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  });

  test('a Sunday starts its own week', () => {
    assert.equal(ymd(weekDays(D('2026-11-08'))[0]), '2026-11-08');
  });

  test('the week the clocks go back still has 7 distinct days at midnight', () => {
    // US DST ended Sunday Nov 1, 2026 (TZ is pinned to Los Angeles).
    const days = weekDays(D('2026-11-04'));
    assert.deepEqual(days.map(ymd),
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    assert.ok(days.every(d => d.getHours() === 0));
  });

  test('the week the clocks go forward too', () => {
    assert.deepEqual(weekDays(D('2027-03-16')).map(ymd)[0], '2027-03-14');
    assert.equal(weekDays(D('2027-03-16'))[6].getHours(), 0);
  });
});

describe('months', () => {
  test('cover whole weeks from the Sunday before the 1st', () => {
    const g = monthGrid(D('2026-11-20'));
    assert.equal(g.length, 5);
    assert.equal(ymd(g[0][0]), '2026-11-01');           // Nov 1 2026 is a Sunday
    assert.equal(ymd(g.at(-1)[6]), '2026-12-05');
  });

  test('can need six rows', () => {
    const g = monthGrid(D('2026-08-01'));                // Aug 1 is a Saturday
    assert.equal(g.length, 6);
    assert.equal(ymd(g[0][0]), '2026-07-26');
  });

  test('can fit in four rows', () => {
    assert.equal(monthGrid(D('2026-02-14')).length, 4);   // Feb 2026 starts on a Sunday
  });
});

describe('navigation', () => {
  test('ranges', () => {
    assert.deepEqual(viewRange('week', D('2026-11-11')), { from: '2026-11-08', to: '2026-11-14' });
    assert.deepEqual(viewRange('month', D('2026-11-11')), { from: '2026-11-01', to: '2026-12-05' });
  });

  test('stepping a month from the 31st does not skip February', () => {
    assert.equal(ymd(shiftAnchor('month', D('2027-01-31'), 1)), '2027-02-01');
    assert.equal(ymd(shiftAnchor('month', D('2027-01-15'), -1)), '2026-12-01');
  });

  test('stepping a week', () => {
    assert.equal(ymd(shiftAnchor('week', D('2026-12-30'), 1)), '2027-01-06');
  });

  test('labels', () => {
    assert.equal(rangeLabel('month', D('2026-11-11')), 'November 2026');
    assert.equal(rangeLabel('week', D('2026-11-11')), 'Nov 8 – 14, 2026');
    assert.equal(rangeLabel('week', D('2026-12-01')), 'Nov 29 – Dec 5, 2026');
    assert.equal(rangeLabel('week', D('2026-12-30')), 'Dec 27, 2026 – Jan 2, 2027');
  });
});

describe('bucket', () => {
  const hw = [
    { id: 'a', description: 'Essay',   deadline: '2026-11-12' },
    { id: 'b', description: 'Quiz',    deadline: '2026-11-12', deadlineTime: '08:00' },
    { id: 'c', description: 'Lab',     deadline: '2026-11-12', deadlineTime: '15:30' },
    { id: 'd', description: 'Done',    deadline: '2026-11-12', completed: true },
    { id: 'e', description: 'Old',     deadline: '2026-10-01' },
    { id: 'f', description: 'Someday' },
    { id: 'g', description: 'Later',   deadline: '2027-01-01' },
  ];
  const r = bucket(hw, { from: '2026-11-08', to: '2026-11-14', today: '2026-11-11' });

  test('every visible day gets a list, empty or not', () => {
    assert.equal(r.days.size, 7);
    assert.deepEqual(r.days.get('2026-11-08'), []);
  });

  test('a day lists timed work first in time order, then untimed', () => {
    assert.deepEqual(r.days.get('2026-11-12').map(h => h.id), ['b', 'c', 'a']);
  });

  test('at the same time, high priority comes first', () => {
    const r2 = bucket([
      { id: 'n', description: 'A', deadline: '2026-11-12' },
      { id: 'h', description: 'B', deadline: '2026-11-12', priority: 'high' },
      { id: 't', description: 'C', deadline: '2026-11-12', deadlineTime: '09:00', priority: 'low' },
    ], { from: '2026-11-08', to: '2026-11-14', today: '2026-11-11' });
    assert.deepEqual(r2.days.get('2026-11-12').map(h => h.id), ['t', 'h', 'n']);
  });

  test('completed work is left out', () => {
    assert.ok(![...r.days.values()].flat().some(h => h.id === 'd'));
  });

  test('overdue work before the range and undated work are collected', () => {
    assert.deepEqual(r.overdue.map(h => h.id), ['e']);
    assert.deepEqual(r.undated.map(h => h.id), ['f']);
  });

  test('looking at a past week, earlier work is not called overdue twice', () => {
    const past = bucket(hw, { from: '2026-09-27', to: '2026-10-03', today: '2026-11-11' });
    assert.deepEqual(past.days.get('2026-10-01').map(h => h.id), ['e']);
    assert.deepEqual(past.overdue, []);
  });

  test('looking at a future week, work due between today and the range is not overdue', () => {
    const future = bucket([{ id: 'x', deadline: '2026-11-20' }], { from: '2026-12-06', to: '2026-12-12', today: '2026-11-11' });
    assert.deepEqual(future.overdue, []);
  });
});

describe('deadlineMsFor', () => {
  test('a bare date means 23:59 that day', () => {
    assert.equal(deadlineMsFor('2026-11-12'), new Date(2026, 10, 12, 23, 59).getTime());
  });
  test('a time is used as given', () => {
    assert.equal(deadlineMsFor('2026-11-12', '08:30'), new Date(2026, 10, 12, 8, 30).getTime());
  });
  test('no date, no timestamp', () => {
    assert.equal(deadlineMsFor(''), null);
  });
});
