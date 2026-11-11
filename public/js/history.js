import { toast } from './utils.js';

/* =============================================================================
   UNDO / REDO HISTORY (max 30 entries)
   ============================================================================= */
const CANCELLED = '__undo_cancelled__';

const history = {
  past:   [],
  future: [],
  _busy:  false,
  push(action) {
    this.past.push(action);
    if (this.past.length > 30) this.past.shift();
    this.future = [];
    updateHistoryBtns();
  },
  async undo() {
    if (!this.past.length || this._busy) return;
    const action = this.past[this.past.length - 1];
    this._busy = true; updateHistoryBtns();
    // Leave the entry on the stack if the undo fails or the user backs out of a
    // confirmation, so Ctrl+Z can be tried again instead of silently burning it.
    try { await action.undo(); }
    catch (err) { if (err?.message !== CANCELLED) toast(`Undo failed: ${err.message}`, 'error'); return; }
    finally { this._busy = false; updateHistoryBtns(); }
    this.past.pop();
    this.future.push(action);
    updateHistoryBtns();
  },
  async redo() {
    if (!this.future.length || this._busy) return;
    const action = this.future[this.future.length - 1];
    this._busy = true; updateHistoryBtns();
    try { await action.redo(); }
    catch (err) { if (err?.message !== CANCELLED) toast(`Redo failed: ${err.message}`, 'error'); return; }
    finally { this._busy = false; updateHistoryBtns(); }
    this.future.pop();
    this.past.push(action);
    updateHistoryBtns();
  }
};

function updateHistoryBtns() {
  document.getElementById('undo-btn').disabled = history._busy || history.past.length === 0;
  document.getElementById('redo-btn').disabled = history._busy || history.future.length === 0;
}

export { CANCELLED, history };
