// search() ranks board items for the command palette.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, MAX_RESULTS } from '../../public/js/search.js';

const DATA = {
  tabs:    [{ id: 't1', name: 'School' }, { id: 't2', name: 'Clubs' }],
  classes: [
    { id: 'bio',  name: 'Biology',  tabId: 't1', teacher: 'Ms. Park', room: 'B12' },
    { id: 'hist', name: 'History',  tabId: 't1' },
    { id: 'rob',  name: 'Robotics', tabId: 't2' },
  ],
  folders: [{ id: 'f1', name: 'Labs', classId: 'bio' }],
  homework: [
    { id: 'h1', description: 'Lab report',         classId: 'bio',  folderId: 'f1', deadline: '2026-11-20' },
    { id: 'h2', description: 'Read chapter 5',     classId: 'hist', deadline: '2026-11-13' },
    { id: 'h3', description: 'Old lab',            classId: 'bio',  completed: true },
    { id: 'h4', description: 'Build the arm',      classId: 'rob',  notes: 'bring the lab kit' },
    { id: 'h5', description: 'Collaborate on lab', classId: 'hist', deadline: '2026-11-12' },
  ],
};
const ids = (q, data = DATA) => search(q, data).map(r => `${r.kind}:${r.id}`);

test('an empty query returns nothing', () => {
  assert.deepEqual(search('   ', DATA), []);
});

test('completed assignments are skipped', () => {
  assert.ok(!ids('old').includes('hw:h3'));
});

test('every word must match, across the item and its context', () => {
  assert.deepEqual(ids('bio lab'), ['hw:h1', 'folder:f1']);
});

test('a match in the name beats a match in the notes', () => {
  const r = ids('lab');
  assert.ok(r.indexOf('hw:h1') < r.indexOf('hw:h4'));
});

test('a word start beats a match inside a word', () => {
  // "Lab report" starts with it, "Collaborate on lab" has it at a later word
  // start, and "bring the lab kit" is only in the notes.
  const r = ids('lab').filter(x => x.startsWith('hw:'));
  assert.deepEqual(r, ['hw:h1', 'hw:h5', 'hw:h4']);
  assert.deepEqual(ids('abor'), ['hw:h5']);                 // inside "Collaborate"
});

test('ties are broken by soonest deadline', () => {
  // h2 and h5 both live in History; both match "history" only via context.
  assert.deepEqual(ids('history').filter(x => x.startsWith('hw:')), ['hw:h5', 'hw:h2']);
});

test('groups match on teacher and room, spaces by name', () => {
  assert.deepEqual(ids('park'), ['class:bio']);
  assert.ok(ids('clubs').includes('tab:t2'));
  assert.ok(ids('clubs').includes('class:rob'));
});

test('case and accents are ignored', () => {
  const data = { ...DATA, homework: [{ id: 'x', description: 'Résumé draft', classId: 'bio' }] };
  assert.deepEqual(ids('RESUME', data), ['hw:x']);
});

test('regex characters in the query are safe', () => {
  assert.doesNotThrow(() => search('a(b[c*', DATA));
});

test('results are capped', () => {
  const homework = Array.from({ length: 50 }, (_, i) => ({ id: `h${i}`, description: `essay ${i}`, classId: 'bio' }));
  assert.equal(search('essay', { ...DATA, homework }).length, MAX_RESULTS);
});
