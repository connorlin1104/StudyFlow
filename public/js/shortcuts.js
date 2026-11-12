import { defaultClassId, splitKey, state } from './state.js';
import { sel } from './selection.js';
import { openHwEditModal, openHwModal } from './hw-modal.js';
import { handleMarkComplete } from './handlers.js';
import { isPaletteOpen, lastJumpedHw, openPalette, togglePalette } from './palette.js';
import { isCalendarView, setView, step } from './calendar.js';

/* =============================================================================
   KEYBOARD SHORTCUTS

     Ctrl/⌘+K, /   search & quick add
     n             new assignment
     e             edit the assignment you're on
     x             mark it complete
     b / w / m     board, week or month view
     ← / →         previous / next week or month, on the calendar
     ?             list these

   "The assignment you're on" is, in order: the one selected (if exactly one
   is), the one under the mouse, or the one the palette last jumped to. Undo and
   redo stay in events.js with the Escape handling they've always lived beside.
   ============================================================================= */

let hoveredHwId = null;

function targetHw() {
  if (sel.ids.size === 1) {
    const [type, id] = splitKey([...sel.ids][0]);
    if (type === 'hw') return id;
  }
  if (hoveredHwId && state.homework.some(h => h.id === hoveredHwId && !h.completed)) return hoveredHwId;
  return lastJumpedHw();
}

function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function openHelp()  { document.getElementById('shortcuts-modal').classList.add('modal--open'); }
function closeHelp() { document.getElementById('shortcuts-modal').classList.remove('modal--open'); }

function onKeydown(e) {
  // Ctrl/⌘+K works from anywhere, even mid-typing, like it does in most apps —
  // unless another dialog is open, which it would end up stacked on top of.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    const otherModal = document.querySelector('.modal--open:not(#palette-modal)');
    if (otherModal) return;
    e.preventDefault();
    togglePalette();
    return;
  }

  // Single-key shortcuts only on the bare board.
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (isTyping(e.target)) return;
  if (document.querySelector('.modal--open') || isPaletteOpen()) return;
  if (document.body.classList.contains('is-dragging')) return;
  if (!document.getElementById('lightbox').classList.contains('hidden')) return;
  if (!state.tabs.length) return;               // signed out / not loaded yet

  switch (e.key) {
    case '/':
      e.preventDefault(); openPalette(); break;
    case '?':
      e.preventDefault(); openHelp(); break;
    case 'n': {
      e.preventDefault();
      const hw = state.homework.find(h => h.id === targetHw());
      openHwModal(hw?.classId ?? defaultClassId(),
                  hw?.folderId ?? null);
      break;
    }
    case 'e': {
      const id = targetHw();
      if (id) { e.preventDefault(); openHwEditModal(id); }
      break;
    }
    case 'x': {
      const id = targetHw();
      if (id) { e.preventDefault(); handleMarkComplete(id); }
      break;
    }
    case 'b': e.preventDefault(); setView('board'); break;
    case 'w': e.preventDefault(); setView('week');  break;
    case 'm': e.preventDefault(); setView('month'); break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (isCalendarView()) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
      break;
  }
}

function wireShortcuts() {
  document.addEventListener('keydown', onKeydown);

  // Track the hovered assignment, on the board or the calendar. pointerover
  // bubbles, unlike pointerenter, so one listener covers cards added by later
  // re-renders.
  const area = document.querySelector('.tab-content');
  area.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    hoveredHwId = e.target.closest('.hw-item, .cal-item')?.dataset.hwId ?? null;
  });
  area.addEventListener('pointerleave', () => { hoveredHwId = null; });

  document.getElementById('shortcuts-backdrop').addEventListener('click', closeHelp);
  document.getElementById('close-shortcuts').addEventListener('click', closeHelp);
}

export { closeHelp, wireShortcuts };
