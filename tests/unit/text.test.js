import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { esc, normalizePeriod } from '../../public/js/utils.js';
import { article, singularize, getNextAvailableColor, PRESET_COLORS } from '../../public/js/constants.js';
import { state } from '../../public/js/state.js';

describe('esc', () => {
  // Everything user-typed goes into innerHTML through this. If it misses a
  // character, an assignment name can inject markup.
  test('escapes HTML special characters', () => {
    assert.equal(esc('<img src=x onerror="alert(1)"> & co'),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co');
  });
  test('null and undefined become empty strings', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
});

describe('normalizePeriod', () => {
  test('numbers, ordinals and words all become "Nth Period"', () => {
    assert.equal(normalizePeriod('3'), '3rd Period');
    assert.equal(normalizePeriod('period 1'), '1st Period');
    assert.equal(normalizePeriod('2nd period'), '2nd Period');
    assert.equal(normalizePeriod('fourth'), '4th Period');
    assert.equal(normalizePeriod('Eleven'), '11th Period');
    assert.equal(normalizePeriod('12'), '12th Period');
  });
  test('anything else is left alone (trimmed)', () => {
    assert.equal(normalizePeriod('  Lunch  '), 'Lunch');
    assert.equal(normalizePeriod('A-block'), 'A-block');
    assert.equal(normalizePeriod('99'), '99');
  });
  test('blank input is returned unchanged', () => {
    assert.equal(normalizePeriod(''), '');
    assert.equal(normalizePeriod(undefined), undefined);
  });
});

describe('article / singularize', () => {
  test('article', () => {
    assert.equal(article('Activity'), 'an');
    assert.equal(article('Class'), 'a');
  });
  test('singularize', () => {
    assert.equal(singularize('Activities'), 'Activity');
    assert.equal(singularize('Classes'), 'Class');
    assert.equal(singularize('Clubs'), 'Club');
    assert.equal(singularize('Boxes'), 'Box');
    assert.equal(singularize('Glass'), 'Glass');
  });
});

describe('getNextAvailableColor', () => {
  beforeEach(() => { state.classes = []; });
  test('picks the first preset color not used in that space', () => {
    state.classes = [
      { tabId: 't', color: PRESET_COLORS[0] },
      { tabId: 't', color: PRESET_COLORS[1] },
      { tabId: 'other', color: PRESET_COLORS[2] },
    ];
    assert.equal(getNextAvailableColor('t'), PRESET_COLORS[2]);
  });
  test('wraps back to the first color when all are used', () => {
    state.classes = PRESET_COLORS.map(color => ({ tabId: 't', color }));
    assert.equal(getNextAvailableColor('t'), PRESET_COLORS[0]);
  });
});
