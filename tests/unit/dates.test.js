// Deadline parsing and display. The npm script pins TZ=America/Los_Angeles so
// these don't change meaning depending on whose laptop (or CI runner) runs them.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeadline } from '../../public/js/utils.js';
import { deadlineValue } from '../../public/js/state.js';

// Freeze "now" so Today/Tomorrow/overdue are deterministic.
// Wednesday 2026-11-11, 2:30pm local.
const NOW = new Date('2026-11-11T14:30:00').getTime();
beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
afterEach(() => mock.timers.reset());

describe('parseDeadline', () => {
  test('no date means no deadline', () => {
    assert.equal(parseDeadline('', ''), null);
    assert.equal(parseDeadline(undefined), null);
  });

  test('relative labels for yesterday / today / tomorrow', () => {
    assert.equal(parseDeadline('2026-11-10').label, 'Due Yesterday');
    assert.equal(parseDeadline('2026-11-11').label, 'Due Today');
    assert.equal(parseDeadline('2026-11-12').label, 'Due Tomorrow');
  });

  test('other dates show month and day, plus the year only when it differs', () => {
    assert.equal(parseDeadline('2026-11-20').label, 'Due Nov 20');
    assert.equal(parseDeadline('2027-01-05').label, 'Due Jan 5, 2027');
  });

  test('a time is appended to the label', () => {
    assert.equal(parseDeadline('2026-11-12', '09:05').label.replace(/ /g, ' '), 'Due Tomorrow at 9:05 AM');
  });

  test('diff counts calendar days from today', () => {
    assert.equal(parseDeadline('2026-11-11').diff, 0);
    assert.equal(parseDeadline('2026-11-14').diff, 3);
    assert.equal(parseDeadline('2026-11-01').diff, -10);
  });

  test('past dates are overdue', () => {
    assert.equal(parseDeadline('2026-11-10').cssClass, 'deadline--overdue');
  });

  test('today with a time that has passed is overdue', () => {
    assert.equal(parseDeadline('2026-11-11', '08:00').cssClass, 'deadline--overdue');
  });

  test('today with a time still ahead is "today"', () => {
    assert.equal(parseDeadline('2026-11-11', '23:00').cssClass, 'deadline--today');
  });

  // A bare date means "sometime that day" (23:59) everywhere else in the app —
  // see deadlineValue below and the README. It must not turn red at 12:01am.
  test('today with no time is "today", not overdue', () => {
    assert.equal(parseDeadline('2026-11-11').cssClass, 'deadline--today');
  });

  // Days around a DST change are 23 or 25 hours long, so counting days by
  // dividing milliseconds drifts by one unless it rounds.
  test('day counts survive the clocks springing forward', () => {
    mock.timers.setTime(new Date('2027-03-13T10:00:00').getTime()); // DST starts 2027-03-14
    assert.equal(parseDeadline('2027-03-14').label, 'Due Tomorrow');
    assert.equal(parseDeadline('2027-03-16').diff, 3);
  });

  test('day counts survive the clocks falling back', () => {
    mock.timers.setTime(new Date('2026-11-02T10:00:00').getTime()); // DST ended 2026-11-01
    assert.equal(parseDeadline('2026-11-01').label, 'Due Yesterday');
  });

  test('a late time tomorrow is still tomorrow', () => {
    assert.equal(parseDeadline('2026-11-12', '23:30').diff, 1);
  });

  test('within three days is "soon", beyond is "ok"', () => {
    assert.equal(parseDeadline('2026-11-14').cssClass, 'deadline--soon');
    assert.equal(parseDeadline('2026-11-15').cssClass, 'deadline--ok');
  });
});

describe('deadlineValue', () => {
  test('no deadline sorts last', () => {
    assert.equal(deadlineValue({}), Infinity);
    assert.equal(deadlineValue(null), Infinity);
  });

  test('a bare date means end of that day (23:59), not midnight', () => {
    assert.equal(deadlineValue({ deadline: '2026-11-11' }), new Date('2026-11-11T23:59').getTime());
  });

  test('an explicit time is used as-is', () => {
    assert.equal(deadlineValue({ deadline: '2026-11-11', deadlineTime: '08:15' }), new Date('2026-11-11T08:15').getTime());
  });
});
