/* =============================================================================
   FIREBASE — auth, firestore, storage; compat SDK (loaded via <script> tags)
   ============================================================================= */
firebase.initializeApp(window.FIREBASE_CONFIG);

const auth    = firebase.auth();
const storage = firebase.storage();
const db      = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;

// Safari (and some proxies/VPNs) fail the WebChannel streaming transport with a
// CORS "access control checks" error, so force long polling. Must run before any
// Firestore call. Costs nothing here — every read is a one-shot get(), no listeners.
db.settings({
  experimentalForceLongPolling:      true,
  experimentalAutoDetectLongPolling: false,
  merge:                             true
});
let currentUser = null;
// Other modules can read an imported `let` but not assign to it, so the auth
// gate in main.js updates the signed-in user through this.
function setCurrentUser(user) { currentUser = user; }

export { FieldValue, auth, currentUser, db, setCurrentUser, storage };
