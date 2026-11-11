import { state } from './state.js';

/* =============================================================================
   CONSTANTS
   ============================================================================= */
const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
];



// Returns the first preset color not yet used in the given tab
function getNextAvailableColor(tabId) {
  const used = new Set(state.classes.filter(c => c.tabId === tabId).map(c => c.color));
  return PRESET_COLORS.find(c => !used.has(c)) ?? PRESET_COLORS[0];
}

// Returns "an" if word starts with a vowel sound, otherwise "a"
function article(word) {
  return /^[aeiouAEIOU]/.test(word) ? 'an' : 'a';
}

// Basic singularizer: "Clubs" → "Club", "Activities" → "Activity", "Classes" → "Class"
function singularize(name) {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (/[sx]es$/.test(name) || name.endsWith('ches') || name.endsWith('shes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

export { PRESET_COLORS, article, getNextAvailableColor, singularize };
