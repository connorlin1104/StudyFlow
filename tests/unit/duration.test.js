// Time estimates: what can be typed, and how it's shown.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseDuration, totalEstimate } from '../../public/js/duration.js';

describe('parseDuration', () => {
  const cases = [
    ['45', 45], ['45m', 45], ['45 min', 45], ['45 minutes', 45], ['90m', 90],
    ['1h', 60], ['1 hr', 60], ['2 hours', 120], ['1.5h', 90], ['1,5h', 90], ['.5h', null],
    ['1h30', 90], ['1h 30m', 90], ['1 hr 30 min', 90], ['1:30', 90], ['0:45', 45],
    [' 2H ', 120], ['24h', 1440],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" → ${want}`, () => assert.equal(parseDuration(input), want));
  }

  test('rejects what is not a duration', () => {
    for (const bad of ['', '   ', null, undefined, 'soon', '0', '0m', '1:75', '-5', '25h', '45x', '1h1h']) {
      assert.equal(parseDuration(bad), null, String(bad));
    }
  });
});

describe('formatDuration', () => {
  test('minutes, hours, and both', () => {
    assert.equal(formatDuration(45), '45m');
    assert.equal(formatDuration(60), '1h');
    assert.equal(formatDuration(90), '1h 30m');
    assert.equal(formatDuration(135), '2h 15m');
  });
  test('nothing for no estimate', () => {
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(undefined), '');
  });
  test('round-trips through parseDuration', () => {
    for (const n of [5, 45, 60, 90, 135, 600]) assert.equal(parseDuration(formatDuration(n)), n);
  });
});

describe('totalEstimate', () => {
  test('adds what is estimated and skips the rest', () => {
    assert.equal(totalEstimate([{ estimateMin: 30 }, {}, { estimateMin: 45 }, { estimateMin: null }]), 75);
    assert.equal(totalEstimate([]), 0);
  });
});
