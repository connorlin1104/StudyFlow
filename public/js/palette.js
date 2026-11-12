import { defaultClassId, selKey, state } from './state.js';
import { esc, parseDeadline } from './utils.js';
import { elementForKey } from './selection.js';
import { setActiveTab } from './render.js';
import { isCalendarView, revealInCalendar } from './calendar.js';
import { openHwModalPrefilled } from './hw-modal.js';
import { search } from './search.js';
import { parseQuickAdd } from './quickadd.js';

/* =============================================================================
   COMMAND PALETTE  (Ctrl/⌘+K or /)

   One box that does two jobs. Typing searches everything on the board and
   Enter jumps to the result. The same text is also read as a new assignment
   ("bio lab report fri 3pm"), offered as a "Create" row that opens the normal
   assignment form already filled in, so nothing is saved until the user
   confirms it there.
   ============================================================================= */

let rows = [];          // what's on screen: { type: 'create'|'hw'|'class'|'folder'|'tab', ... }
let active = 0;
let lastJumpedHwId = null;

const $ = id => document.getElementById(id);

function isPaletteOpen() { return $('palette-modal').classList.contains('modal--open'); }

let returnFocus = null;  // where focus was before the palette opened

function openPalette(initial = '') {
  if (!isPaletteOpen()) returnFocus = document.activeElement;
  const input = $('palette-input');
  input.value = initial;
  $('palette-modal').classList.add('modal--open');
  input.focus();
  input.select();
  update();
}

// Focus must leave the hidden input, or every later keypress counts as
// "typing" and the single-key shortcuts stop working until the user clicks.
function closePalette() {
  if (!isPaletteOpen()) return;
  $('palette-modal').classList.remove('modal--open');
  if ($('palette-modal').contains(document.activeElement)) {
    const back = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : null;
    if (back) back.focus({ preventScroll: true }); else document.activeElement.blur();
  }
  returnFocus = null;
}

function togglePalette() { isPaletteOpen() ? closePalette() : openPalette(); }

// The assignment the palette last jumped to, for the keyboard shortcuts to act
// on. Forgotten once it's gone from the board.
function lastJumpedHw() {
  const hw = lastJumpedHwId && state.homework.find(h => h.id === lastJumpedHwId);
  return hw && !hw.completed ? hw.id : null;
}

/* -----------------------------------------------------------------------------
   Building the list
   ----------------------------------------------------------------------------- */
function update() {
  const query = $('palette-input').value;
  const results = search(query, state).map(r => ({ type: r.kind, id: r.id }));

  // The "Create" row leads when the text clearly reads as a new assignment
  // (it has a date or time in it) or matched nothing; otherwise it trails.
  const parsed = query.trim() ? parseQuickAdd(query, {
    groups: state.classes, activeTabId: state.activeTabId, now: new Date(),
  }) : null;
  const create = parsed?.description && state.classes.length ? { type: 'create', parsed } : null;
  const createFirst = create && (parsed.deadline || !results.length);

  rows = [...(createFirst ? [create] : []), ...results, ...(create && !createFirst ? [create] : [])];
  active = 0;
  render(query);
}

function groupDot(cls) {
  return `<span class="palette-dot" style="--color:${esc(cls?.color || '#94a3b8')}"></span>`;
}

function rowHtml(row, i) {
  const tabName = id => state.tabs.find(t => t.id === id)?.name || '';
  const clsOf   = id => state.classes.find(c => c.id === id);
  let icon = '', title = '', meta = '';

  if (row.type === 'create') {
    const p = row.parsed;
    const cls = clsOf(p.classId || defaultClassId());
    const due = parseDeadline(p.deadline, p.deadlineTime);
    icon  = '<span class="palette-icon palette-icon--create">+</span>';
    title = `Create “${esc(p.description)}”`;
    meta  = [cls && `${groupDot(cls)}${esc(cls.name)}`, due && esc(due.label)].filter(Boolean).join(' · ');
  } else if (row.type === 'hw') {
    const hw = state.homework.find(h => h.id === row.id);
    const cls = clsOf(hw.classId);
    const due = parseDeadline(hw.deadline, hw.deadlineTime);
    icon  = groupDot(cls);
    title = esc(hw.description);
    meta  = [cls && esc(cls.name), cls && esc(tabName(cls.tabId)), due && esc(due.label)].filter(Boolean).join(' · ');
  } else if (row.type === 'class') {
    const cls = clsOf(row.id);
    icon  = groupDot(cls);
    title = esc(cls.name);
    meta  = `Group · ${esc(tabName(cls.tabId))}`;
  } else if (row.type === 'folder') {
    const f = state.folders.find(x => x.id === row.id);
    const cls = clsOf(f.classId);
    icon  = '<span class="palette-icon" aria-hidden="true">📁</span>';
    title = esc(f.name);
    meta  = `Folder · ${esc(cls?.name || '')}`;
  } else {
    const t = state.tabs.find(x => x.id === row.id);
    icon  = '<span class="palette-icon" aria-hidden="true">▤</span>';
    title = esc(t.name);
    meta  = 'Space';
  }
  return `<li class="palette-row${i === active ? ' palette-row--active' : ''}" role="option"
             id="palette-row-${i}" data-index="${i}" aria-selected="${i === active}">
    ${icon}<span class="palette-text"><span class="palette-title">${title}</span>
    ${meta ? `<span class="palette-meta">${meta}</span>` : ''}</span></li>`;
}

function render(query) {
  const list = $('palette-results');
  if (!query.trim()) {
    list.innerHTML = `<li class="palette-empty">Search your assignments, groups and spaces &mdash;
      or type a new assignment, like <em>bio lab report fri 3pm</em>.</li>`;
  } else if (!rows.length) {
    list.innerHTML = state.classes.length
      ? '<li class="palette-empty">Nothing matches.</li>'
      : '<li class="palette-empty">Nothing matches. Add a group in Settings to create assignments.</li>';
  } else {
    list.innerHTML = rows.map(rowHtml).join('');
  }
  $('palette-input').setAttribute('aria-activedescendant', rows.length ? `palette-row-${active}` : '');
}

function setActive(i) {
  if (!rows.length) return;
  active = (i + rows.length) % rows.length;
  const list = $('palette-results');
  list.querySelectorAll('.palette-row').forEach(el => {
    const on = +el.dataset.index === active;
    el.classList.toggle('palette-row--active', on);
    el.setAttribute('aria-selected', String(on));
  });
  list.querySelector('.palette-row--active')?.scrollIntoView({ block: 'nearest' });
  $('palette-input').setAttribute('aria-activedescendant', `palette-row-${active}`);
}

/* -----------------------------------------------------------------------------
   Acting on a row
   ----------------------------------------------------------------------------- */

function choose(i) {
  const row = rows[i];
  if (!row) return;
  closePalette();
  if (row.type === 'create') openHwModalPrefilled({ ...row.parsed, classId: row.parsed.classId || defaultClassId() });
  else jumpTo(row.type, row.id);
}

// Open a collapsed group or folder on screen so the target is visible. This
// is deliberately not saved to prefs — jumping somewhere shouldn't rearrange
// what the user chose to keep closed next time.
function reveal(el) {
  const row = el.closest('.class-row');
  if (row && row !== el && row.classList.contains('class-row--collapsed')) {
    row.classList.remove('class-row--collapsed');
    const btn = row.querySelector('.class-toggle-btn');
    if (btn) { btn.textContent = '▾'; btn.setAttribute('aria-expanded', 'true'); }
  }
  const folder = el.closest('.folder');
  if (folder && folder !== el && folder.classList.contains('folder--collapsed')) {
    folder.classList.remove('folder--collapsed');
    const btn = folder.querySelector('.folder-toggle-btn');
    if (btn) { btn.textContent = '▾'; btn.setAttribute('aria-expanded', 'true'); }
    const icon = folder.querySelector('.folder-icon');
    if (icon) icon.textContent = '📂';
  }
}

function jumpTo(kind, id) {
  // On the calendar, an assignment with a date is shown there, in its week or
  // month. Anything else (a group, a folder, undated work) needs the board.
  if (kind === 'hw' && isCalendarView() && revealInCalendar(id)) { lastJumpedHwId = id; return; }
  if (kind === 'tab') {
    if (state.activeTabId !== id || isCalendarView()) setActiveTab(id);
    return;
  }
  const classId = kind === 'class'  ? id
                : kind === 'folder' ? state.folders.find(f => f.id === id)?.classId
                :                     state.homework.find(h => h.id === id)?.classId;
  const tabId = state.classes.find(c => c.id === classId)?.tabId;
  if (tabId && (tabId !== state.activeTabId || isCalendarView())) setActiveTab(tabId);

  const el = elementForKey(selKey(kind, id));
  if (!el) return;
  reveal(el);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('palette-flash');
  void el.offsetWidth;                       // restart the animation if repeated
  el.classList.add('palette-flash');
  el.addEventListener('animationend', () => el.classList.remove('palette-flash'), { once: true });
  if (kind === 'hw') lastJumpedHwId = id;
}

/* -----------------------------------------------------------------------------
   Wiring
   ----------------------------------------------------------------------------- */
function wirePalette() {
  const input = $('palette-input');
  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')   { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') {
      // Handled here so the global Escape doesn't also clear the selection.
      e.preventDefault(); e.stopPropagation(); closePalette();
    }
  });
  const list = $('palette-results');
  list.addEventListener('click', e => {
    const row = e.target.closest('.palette-row');
    if (row) choose(+row.dataset.index);
  });
  list.addEventListener('mousemove', e => {
    const row = e.target.closest('.palette-row');
    if (row && +row.dataset.index !== active) setActive(+row.dataset.index);
  });
  $('palette-backdrop').addEventListener('click', closePalette);
  $('search-btn').addEventListener('click', () => openPalette());
}

export { closePalette, isPaletteOpen, lastJumpedHw, openPalette, togglePalette, wirePalette };
