// How a group's top level and a folder's contents are ordered. This is the
// logic behind drag-to-reorder: get it wrong and items jump around on reload.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, groupChildren, folderChildren, priorityRank, resortClasses } from '../../public/js/state.js';

// state is a shared module-level object; reset it in place between tests.
function setState(s) {
  Object.assign(state, { tabs: [], classes: [], folders: [], homework: [], ...s });
}
beforeEach(() => setState({}));

const ids = items => items.map(i => `${i.type}:${i.id}`);

describe('groupChildren', () => {
  test('with no manual order, sorts by deadline, undated last', () => {
    setState({ homework: [
      { id: 'c', classId: 'g' },
      { id: 'a', classId: 'g', deadline: '2026-11-20' },
      { id: 'b', classId: 'g', deadline: '2026-11-12' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:b', 'hw:a', 'hw:c']);
  });

  test('manual order wins over deadlines once anything has one', () => {
    setState({ homework: [
      { id: 'soon', classId: 'g', deadline: '2026-11-12', order: 1 },
      { id: 'late', classId: 'g', deadline: '2026-12-30', order: 0 },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:late', 'hw:soon']);
  });

  test('items without an order go after ordered ones', () => {
    setState({ homework: [
      { id: 'new', classId: 'g', deadline: '2026-11-12' },
      { id: 'old', classId: 'g', order: 0 },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:old', 'hw:new']);
  });

  test('folders and loose assignments share one order sequence', () => {
    setState({
      folders:  [{ id: 'f', classId: 'g', order: 1 }],
      homework: [{ id: 'x', classId: 'g', order: 0 }, { id: 'y', classId: 'g', order: 2 }],
    });
    assert.deepEqual(ids(groupChildren('g')), ['hw:x', 'fd:f', 'hw:y']);
  });

  test('leaves out completed work, assignments inside folders, and other groups', () => {
    setState({ homework: [
      { id: 'keep',  classId: 'g' },
      { id: 'done',  classId: 'g', completed: true },
      { id: 'inner', classId: 'g', folderId: 'f' },
      { id: 'other', classId: 'h' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:keep']);
  });

  test('ties break the same way every time (folders first, then by id)', () => {
    setState({
      folders:  [{ id: 'f', classId: 'g' }],
      homework: [{ id: 'b', classId: 'g' }, { id: 'a', classId: 'g' }],
    });
    // Undated assignments tie with folders on deadline (both Infinity).
    assert.deepEqual(ids(groupChildren('g')), ['fd:f', 'hw:a', 'hw:b']);
    assert.deepEqual(ids(groupChildren('g')), ['fd:f', 'hw:a', 'hw:b']);
  });
});

describe('priority', () => {
  test('high priority goes first among assignments due at the same time, low last', () => {
    setState({ homework: [
      { id: 'a', classId: 'g', deadline: '2026-11-12', priority: 'low' },
      { id: 'b', classId: 'g', deadline: '2026-11-12' },
      { id: 'c', classId: 'g', deadline: '2026-11-12', priority: 'high' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:c', 'hw:b', 'hw:a']);
  });

  test('it never beats an earlier due date', () => {
    setState({ homework: [
      { id: 'later', classId: 'g', deadline: '2026-11-20', priority: 'high' },
      { id: 'sooner', classId: 'g', deadline: '2026-11-12', priority: 'low' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:sooner', 'hw:later']);
  });

  test('it sorts undated work too', () => {
    setState({ homework: [
      { id: 'a', classId: 'g' },
      { id: 'b', classId: 'g', priority: 'high' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:b', 'hw:a']);
  });

  test('manual order still wins', () => {
    setState({ homework: [
      { id: 'a', classId: 'g', order: 0 },
      { id: 'b', classId: 'g', order: 1, priority: 'high' },
    ] });
    assert.deepEqual(ids(groupChildren('g')), ['hw:a', 'hw:b']);
  });

  test('priorityRank: missing or unknown reads as normal', () => {
    assert.deepEqual([{ priority: 'high' }, {}, { priority: 'low' }, { priority: 'urgent' }, null].map(priorityRank), [0, 1, 2, 1, 1]);
  });
});

describe('folderChildren', () => {
  test('only pending assignments in that folder, in their own order', () => {
    setState({ homework: [
      { id: 'b', classId: 'g', folderId: 'f', order: 1 },
      { id: 'a', classId: 'g', folderId: 'f', order: 0 },
      { id: 'done', classId: 'g', folderId: 'f', completed: true, order: 2 },
      { id: 'elsewhere', classId: 'g', folderId: 'other' },
    ] });
    assert.deepEqual(ids(folderChildren('f')), ['hw:a', 'hw:b']);
  });
});

describe('resortClasses', () => {
  test('groups sort by space order first, then their own order', () => {
    setState({
      tabs: [{ id: 't1' }, { id: 't2' }],
      classes: [
        { id: 'b2', tabId: 't2', order: 0 },
        { id: 'a1', tabId: 't1', order: 1 },
        { id: 'a0', tabId: 't1', order: 0 },
      ],
    });
    resortClasses();
    assert.deepEqual(state.classes.map(c => c.id), ['a0', 'a1', 'b2']);
  });
});
