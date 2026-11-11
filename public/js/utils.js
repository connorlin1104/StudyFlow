/* =============================================================================
   UTILITIES
   ============================================================================= */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizePeriod(raw) {
  if (!raw?.trim()) return raw;
  const s = raw.trim();
  const WORD_MAP = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12
  };
  function ordinal(n) {
    if ([11,12,13].includes(n%100)) return `${n}th`;
    const r = n%10;
    if (r===1) return `${n}st`;
    if (r===2) return `${n}nd`;
    if (r===3) return `${n}rd`;
    return `${n}th`;
  }
  const stripped = s.replace(/^\bperiod\b\s*/i,'').replace(/\s*\bperiod\b$/i,'').trim();
  const numMatch = stripped.match(/^(\d+)(st|nd|rd|th)?$/i);
  if (numMatch) { const n = parseInt(numMatch[1],10); if (n>=1 && n<=20) return `${ordinal(n)} Period`; }
  const lower = stripped.toLowerCase();
  if (WORD_MAP[lower] !== undefined) return `${ordinal(WORD_MAP[lower])} Period`;
  return s;
}

function parseDeadline(dateStr, timeStr) {
  if (!dateStr) return null;
  const due   = new Date(dateStr + (timeStr ? `T${timeStr}:00` : 'T00:00:00'));
  const today = new Date();
  today.setHours(0,0,0,0);
  const diff  = Math.floor((due-today)/86_400_000);
  let label;
  if (diff === 0)       label = 'Today';
  else if (diff === 1)  label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else label = due.toLocaleDateString('en-US', {
    month:'short', day:'numeric',
    ...(due.getFullYear()!==today.getFullYear() && {year:'numeric'})
  });
  if (timeStr) {
    label += ' at ' + due.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  }
  // Overdue if past the deadline date, or same day but the time has already passed
  const overdue = diff < 0 || (diff === 0 && due < new Date());
  const cssClass = overdue          ? 'deadline--overdue'
                 : diff === 0       ? 'deadline--today'
                 : diff <= 3        ? 'deadline--soon'
                 : 'deadline--ok';
  return { label: `Due ${label}`, diff, cssClass };
}

function deadlineCssClass(diff) {
  if (diff===null||diff===undefined) return '';
  if (diff<0)   return 'deadline--overdue';
  if (diff===0) return 'deadline--today';
  if (diff<=3)  return 'deadline--soon';
  return 'deadline--ok';
}

/* =============================================================================
   TOAST
   ============================================================================= */
function toast(message, type='info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--show'));
  setTimeout(() => {
    el.classList.remove('toast--show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 3500);
}

/* =============================================================================
   CUSTOM CONFIRM DIALOG
   ============================================================================= */
function showConfirm({ title, message = '', confirmText = 'Delete', confirmClass = 'btn-danger', icon = '🗑️' }) {
  return new Promise(resolve => {
    const dialog     = document.getElementById('confirm-dialog');
    const titleEl    = document.getElementById('confirm-title');
    const messageEl  = document.getElementById('confirm-message');
    const iconEl     = document.getElementById('confirm-icon');
    const okBtn      = document.getElementById('confirm-ok');
    const cancelBtn  = document.getElementById('confirm-cancel');
    const backdrop   = document.getElementById('confirm-backdrop');

    titleEl.textContent   = title;
    iconEl.textContent    = icon;
    okBtn.textContent     = confirmText;
    okBtn.className       = `btn ${confirmClass}`;

    if (message) {
      messageEl.textContent = message;
      messageEl.classList.remove('hidden');
    } else {
      messageEl.classList.add('hidden');
    }

    dialog.classList.add('modal--open');
    cancelBtn.focus();

    function cleanup(result) {
      dialog.classList.remove('modal--open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

export { esc, normalizePeriod, parseDeadline, showConfirm, toast };
