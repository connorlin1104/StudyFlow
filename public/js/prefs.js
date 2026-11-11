/* =============================================================================
   PREFERENCES (persisted to localStorage)
   ============================================================================= */
const ACCENT_OPTIONS = [
  { label: 'Blue',   value: '#3b82f6', hover: '#2563eb' },
  { label: 'Indigo', value: '#6366f1', hover: '#4f46e5' },
  { label: 'Purple', value: '#8b5cf6', hover: '#7c3aed' },
  { label: 'Rose',   value: '#f43f5e', hover: '#e11d48' },
  { label: 'Orange', value: '#f97316', hover: '#ea580c' },
  { label: 'Green',  value: '#22c55e', hover: '#16a34a' },
  { label: 'Teal',   value: '#14b8a6', hover: '#0d9488' },
];

const prefs = {
  _data: JSON.parse(localStorage.getItem('sf-prefs') || '{}'),
  get(key, def) { return key in this._data ? this._data[key] : def; },
  set(key, val) { this._data[key] = val; localStorage.setItem('sf-prefs', JSON.stringify(this._data)); }
};

function applyPrefs() {
  const theme = prefs.get('theme', 'light');
  document.documentElement.setAttribute('data-theme', theme);

  const accent = ACCENT_OPTIONS.find(a => a.value === prefs.get('accent', '#3b82f6')) || ACCENT_OPTIONS[0];
  document.documentElement.style.setProperty('--primary', accent.value);
  document.documentElement.style.setProperty('--primary-hover', accent.hover);

  document.body.classList.toggle('pref-compact', prefs.get('compact', false));

  const showSummary = prefs.get('showSummary', true);
  const panel = document.querySelector('.summary-panel');
  if (panel) panel.classList.toggle('summary-panel--collapsed', !showSummary);
}

export { ACCENT_OPTIONS, applyPrefs, prefs };
