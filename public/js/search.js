/* =============================================================================
   SEARCH

   Ranks spaces, groups, folders and pending assignments against a query, for
   the command palette. Pure, like quickadd.js: the caller passes the data in,
   so tests/unit/search.test.js can run it under Node.

   Every word of the query has to appear somewhere (AND, not OR), in the item's
   own name or in its context — an assignment's notes, its group's name, its
   space's name. So "bio lab" finds the lab report in Biology even though
   neither field holds both words. Matches in the item's own name rank above
   context matches, and a word that starts a word ranks above one buried inside.
   ============================================================================= */

const MAX_RESULTS = 30;

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// How well one query word matches one field: 3 = starts the field,
// 2 = starts a word in it, 1 = appears inside a word, 0 = absent.
function wordScore(field, q) {
  const i = field.indexOf(q);
  if (i === -1) return 0;
  if (i === 0) return 3;
  // Look for an occurrence at a word boundary, not just the first one.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
  return re.test(field) ? 2 : 1;
}

// Primary field counts double; returns 0 if any word matches nowhere.
function score(queryWords, primary, secondary) {
  let total = 0;
  for (const q of queryWords) {
    const p = wordScore(primary, q) * 2;
    const s = Math.max(0, ...secondary.map(f => wordScore(f, q)));
    const best = Math.max(p, s);
    if (!best) return 0;
    total += best;
  }
  return total;
}

// Kinds that are usually what you're looking for come first on a tie.
const KIND_ORDER = { hw: 0, class: 1, folder: 2, tab: 3 };

/**
 * @param {string} query
 * @param {{tabs, classes, folders, homework}} data   the app's state object
 * @returns {Array<{kind: 'hw'|'class'|'folder'|'tab', id: string, score: number}>}
 */
function search(query, { tabs = [], classes = [], folders = [], homework = [] } = {}) {
  const queryWords = norm(query).split(/\s+/).filter(Boolean);
  if (!queryWords.length) return [];

  const tabName   = new Map(tabs.map(t => [t.id, norm(t.name)]));
  const classById = new Map(classes.map(c => [c.id, c]));
  const folderName = new Map(folders.map(f => [f.id, norm(f.name)]));
  const results = [];
  const add = (kind, id, s, deadline) => { if (s) results.push({ kind, id, score: s, deadline }); };

  for (const hw of homework) {
    if (hw.completed) continue;
    const cls = classById.get(hw.classId);
    add('hw', hw.id, score(queryWords, norm(hw.description), [
      norm(hw.notes), norm(cls?.name), folderName.get(hw.folderId) || '', tabName.get(cls?.tabId) || '',
    ]), hw.deadline || '9999');
  }
  for (const c of classes) {
    add('class', c.id, score(queryWords, norm(c.name), [
      norm(c.teacher), norm(c.room), norm(c.period), tabName.get(c.tabId) || '',
    ]));
  }
  for (const f of folders) {
    const cls = classById.get(f.classId);
    add('folder', f.id, score(queryWords, norm(f.name), [norm(cls?.name), tabName.get(cls?.tabId) || '']));
  }
  for (const t of tabs) add('tab', t.id, score(queryWords, norm(t.name), []));

  // Best score first; then assignments before groups etc.; then soonest due.
  results.sort((a, b) => b.score - a.score
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.deadline && b.deadline ? a.deadline.localeCompare(b.deadline) : 0));
  return results.slice(0, MAX_RESULTS).map(({ kind, id, score }) => ({ kind, id, score }));
}

export { search, MAX_RESULTS };
