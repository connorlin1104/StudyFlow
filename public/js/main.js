import { auth, setCurrentUser } from './firebase.js';
import { api, batchDelete, deleteAttachments, userCol } from './api.js';
import { resortClasses, state } from './state.js';
import { applyPrefs, prefs } from './prefs.js';
import { toast } from './utils.js';
import { renderSchedule, renderTabBar } from './render.js';
import { renderSummary } from './summary.js';
import { initAccentSwatches, initColorSwatches } from './settings.js';
import { registerServiceWorker } from './notifications.js';
import { wireEvents } from './events.js';
import { currentView } from './calendar.js';

/* =============================================================================
   INIT
   ============================================================================= */
let _appBooted = false;
async function init() {
  if (!_appBooted) {
    _appBooted = true;
    initColorSwatches();
    initAccentSwatches();
    wireEvents();
    applyPrefs();
    registerServiceWorker();
  }
  document.getElementById('classes-container').innerHTML = `
    <div class="data-loading">
      <div class="spinner"></div>
      <p>Loading your data…</p>
    </div>`;
  document.getElementById('empty-state').classList.add('hidden');

  try {
    const [tabs, classes, folders, homework] = await Promise.all([
      api.tabs.list(),
      api.classes.list(),
      api.folders.list(),
      api.homework.list()
    ]);
    state.tabs     = tabs;
    state.classes  = classes;
    state.folders  = folders;
    state.homework = homework;
    resortClasses();
    _lastRefresh   = Date.now();
    if (!state.activeTabId || !tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();

    // Sync notifyBefore and the daily study time from Firestore so all devices
    // share them. localStorage is only a cache, so the first paint isn't blank.
    api.notifications.getPrefs().then(r => {
      if (r?.notifyBefore != null && r.notifyBefore !== prefs.get('notifyBefore', 60)) {
        prefs.set('notifyBefore', r.notifyBefore);
        const el = document.getElementById('pref-notify-before');
        if (el) el.value = String(r.notifyBefore);
      }
      if (r?.dailyBudgetMin > 0 && r.dailyBudgetMin !== prefs.get('dailyBudgetMin')) {
        prefs.set('dailyBudgetMin', r.dailyBudgetMin);
        if (currentView() === 'today') renderSchedule();
      }
    }).catch(() => {});

    pruneOldCompleted();   // housekeeping; deliberately not awaited
  } catch (err) {
    toast(`Failed to load data: ${err.message}`, 'error');
    console.error(err);
    document.getElementById('classes-container').innerHTML = `
      <div style="padding:32px;text-align:center;color:#ef4444;">
        <strong>Could not load your data.</strong><br>
        <span style="font-size:0.85rem;color:#64748b;">${err.message}</span><br><br>
        <button class="btn btn-secondary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

/* =============================================================================
   PRUNE OLD COMPLETED ASSIGNMENTS
   A scheduled Cloud Function used to delete completed assignments 30 days after
   completion. It died with the move to the Spark plan, so they accumulated
   invisibly — hidden from the board, but still real documents that showed up in
   the "this will also delete N assignments" count. This restores that policy on
   the client. It runs against already-loaded state, so it costs no extra reads.
   ============================================================================= */
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneOldCompleted() {
  const done = state.homework.filter(h => h.completed);
  if (!done.length) return;

  const cutoff = Date.now() - COMPLETED_TTL_MS;
  const stale  = done.filter(h => h.completedAt?.seconds && h.completedAt.seconds * 1000 <= cutoff);
  // Assignments completed before completedAt was recorded have no age, so they
  // would never expire. Stamp them instead of guessing: they age out 30 days
  // from now rather than being deleted on a date we can't actually establish.
  const undated = done.filter(h => !h.completedAt?.seconds);

  try {
    if (undated.length) {
      await Promise.all(undated.map(h => api.homework.update(h.id, { completed: true })));
    }
    if (!stale.length) return;

    // Completing an assignment already clears its attachments, but documents
    // predating that behaviour may still be holding files in Storage.
    await Promise.all(stale.filter(h => h.attachments?.length)
                           .map(h => deleteAttachments(h.attachments)));
    await batchDelete(stale.map(h => userCol('homework').doc(h.id)));

    const gone = new Set(stale.map(h => h.id));
    state.homework = state.homework.filter(h => !gone.has(h.id));
    renderSummary();
    toast(`Cleaned up ${stale.length} completed assignment${stale.length === 1 ? '' : 's'} older than 30 days`, 'info');
  } catch (err) {
    // Never block startup over housekeeping — it'll try again next load
    console.warn('Prune of old completed assignments failed:', err);
  }
}

/* =============================================================================
   REFRESH ON FOCUS
   Nothing here uses snapshot listeners — every read is a one-shot get() — so an
   edit made on another device stays invisible until we re-read. That's not just
   a display problem: a stale list gets written back wholesale by the next
   drag-to-reorder, silently undoing the other device's work. Re-reading when the
   tab regains focus covers the realistic case (phone, then back to the laptop).
   ============================================================================= */
// Each refresh re-reads every doc, and Spark allows 50k reads/day, so rate-limit
// it. A minute is plenty — nobody switches phone → laptop faster than that.
const REFRESH_MIN_GAP_MS = 60_000;
let _lastRefresh = 0;
let _refreshing  = false;

async function refreshFromServer() {
  if (_refreshing || !auth.currentUser || !_appBooted) return;
  if (Date.now() - _lastRefresh < REFRESH_MIN_GAP_MS) return;
  // Never yank the data out from under an in-flight drag or a half-filled form
  if (document.body.classList.contains('is-dragging')) return;
  if (document.querySelector('.modal--open')) return;

  _refreshing = true;
  try {
    const [tabs, classes, folders, homework] = await Promise.all([
      api.tabs.list(), api.classes.list(), api.folders.list(), api.homework.list()
    ]);
    _lastRefresh   = Date.now();
    state.tabs     = tabs;
    state.classes  = classes;
    state.folders  = folders;
    state.homework = homework;
    resortClasses();
    if (!state.activeTabId || !tabs.find(t => t.id === state.activeTabId)) {
      state.activeTabId = tabs[0]?.id ?? null;
    }
    renderTabBar();
    renderSchedule();
    renderSummary();
  } catch (err) {
    // Stay quiet: this is background work and the stale view still functions
    console.warn('Background refresh failed:', err);
  } finally {
    _refreshing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromServer();
});
window.addEventListener('focus', refreshFromServer);

/* =============================================================================
   AUTH GATE — wait for Firebase to restore session before doing anything
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  const authScreen  = document.getElementById('auth-screen');
  const authLoading = document.getElementById('auth-loading');
  const authCard    = document.getElementById('auth-card');
  const appWrapper  = document.getElementById('app-wrapper');

  const PERSONAL_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com','live.com','msn.com','aol.com','protonmail.com']);
  const isOrgEmail = email => !PERSONAL_DOMAINS.has(email.split('@')[1]?.toLowerCase());

  // Email / password auth
  let authMode = 'signin'; // 'signin' | 'signup'

  function friendlyAuthError(code) {
    switch (code) {
      case 'auth/invalid-email':        return 'Invalid email address.';
      case 'auth/user-not-found':       return 'No account with that email.';
      case 'auth/wrong-password':       return 'Incorrect password.';
      case 'auth/email-already-in-use': return 'An account with that email already exists.';
      case 'auth/weak-password':        return 'Password must be at least 6 characters.';
      case 'auth/too-many-requests':    return 'Too many attempts. Try again later.';
      case 'auth/invalid-credential':   return 'Incorrect email or password.';
      default:                          return 'Something went wrong. Please try again.';
    }
  }

  function showAuthError(elId, msg) {
    const el = document.getElementById(elId);
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else     { el.textContent = ''; el.classList.add('hidden'); }
  }

  function showAuthPanel(panel) {
    document.getElementById('auth-panel-main').classList.toggle('hidden', panel !== 'main');
    document.getElementById('auth-panel-forgot').classList.toggle('hidden', panel !== 'forgot');
  }

  // Sign in / sign up toggle
  document.getElementById('auth-toggle').addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    const isSignup = authMode === 'signup';
    document.getElementById('email-auth-submit').textContent = isSignup ? 'Create Account' : 'Sign In';
    document.getElementById('auth-toggle').textContent = isSignup ? 'Sign in' : 'Sign up';
    document.getElementById('auth-forgot').classList.toggle('hidden', isSignup);
    showAuthError('auth-error', '');
  });

  // Email / password submit
  document.getElementById('email-auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const btn      = document.getElementById('email-auth-submit');
    showAuthError('auth-error', '');
    btn.disabled = true;
    try {
      if (authMode === 'signup') {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        // Reported through sendVerification, not thrown: the account exists
        // either way, and the gate has already moved on to the verify screen,
        // where this form's error line is no longer on screen.
        if (!isOrgEmail(email)) await sendVerification(cred.user);
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }
    } catch (err) {
      showAuthError('auth-error', friendlyAuthError(err.code));
    } finally {
      btn.disabled = false;
    }
  });

  // Forgot password — show dedicated panel
  document.getElementById('auth-forgot').addEventListener('click', () => {
    const prefill = document.getElementById('auth-email').value.trim();
    document.getElementById('auth-reset-email').value = prefill;
    showAuthError('auth-reset-error', '');
    showAuthPanel('forgot');
  });

  document.getElementById('auth-back').addEventListener('click', () => {
    showAuthPanel('main');
  });

  document.getElementById('auth-reset-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-reset-email').value.trim();
    const btn   = document.getElementById('auth-reset-submit');
    if (!email) { showAuthError('auth-reset-error', 'Enter your email address.'); return; }
    showAuthError('auth-reset-error', '');
    btn.disabled = true;
    try {
      await auth.sendPasswordResetEmail(email);
      toast('Password reset email sent — check your inbox.', 'success');
      showAuthPanel('main');
    } catch (err) {
      showAuthError('auth-reset-error', friendlyAuthError(err.code));
    } finally {
      btn.disabled = false;
    }
  });

  /* Verification screen actions.

     Firebase throttles verification mail hard once a few go out in quick
     succession, and answers with auth/too-many-requests rather than sending.
     Pressing Resend repeatedly is therefore the one thing guaranteed to stop
     the email arriving — so the button locks itself out between sends, and a
     refusal says which refusal it was instead of being swallowed whole. */
  const resendBtn = document.getElementById('auth-resend-btn');
  let resendUntil = 0, resendTimer = null;

  function tickResend() {
    const left = Math.ceil((resendUntil - Date.now()) / 1000);
    if (left > 0) {
      resendBtn.disabled  = true;
      resendBtn.textContent = `Resend Email (${left}s)`;
    } else {
      clearInterval(resendTimer); resendTimer = null;
      resendBtn.disabled  = false;
      resendBtn.textContent = 'Resend Email';
    }
  }
  function holdResend(seconds) {
    resendUntil = Date.now() + seconds * 1000;
    if (!resendTimer) resendTimer = setInterval(tickResend, 500);
    tickResend();
  }

  async function sendVerification(user) {
    try {
      await user.sendEmailVerification();
      toast('Verification email sent — check your inbox, including spam.', 'success');
      holdResend(60);
      return true;
    } catch (err) {
      console.error('[verification email]', err.code, err.message);
      toast(err.code === 'auth/too-many-requests'
        ? 'Firebase has paused sending for this account after too many requests. Wait a few minutes, then try once.'
        : `Could not send: ${friendlyAuthError(err.code)} (${err.code || 'no code'})`, 'error');
      holdResend(err.code === 'auth/too-many-requests' ? 300 : 30);
      return false;
    }
  }

  resendBtn.addEventListener('click', () => {
    if (Date.now() < resendUntil || !auth.currentUser) return;
    resendBtn.disabled = true;
    sendVerification(auth.currentUser);
  });
  document.getElementById('auth-verify-signout').addEventListener('click', () => auth.signOut());

  // Google sign-in
  document.getElementById('google-signin-btn').addEventListener('click', () => {
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => {
      toast(`Sign-in failed: ${err.message}`, 'error');
    });
  });


  /* Clicking the link in the email verifies the account on Firebase's side, but
     `emailVerified` is baked into the ID token this tab is already holding and
     onAuthStateChanged does not re-fire — so without re-reading the user, the
     tab sits on "Check your inbox" forever even after a successful
     verification, and the only way through is a manual page reload. Poll while
     that screen is up, and again whenever the tab regains focus, which is
     exactly when someone comes back from their mail app. */
  let verifyPoll = null;

  function stopVerifyPoll() {
    if (verifyPoll) { clearInterval(verifyPoll); verifyPoll = null; }
    window.removeEventListener('focus', checkVerified);
  }
  function startVerifyPoll() {
    if (verifyPoll) return;
    verifyPoll = setInterval(checkVerified, 4000);
    window.addEventListener('focus', checkVerified);
  }
  async function checkVerified() {
    const user = auth.currentUser;
    if (!user) { stopVerifyPoll(); return; }
    try { await user.reload(); } catch { return; }   // offline, or a revoked token
    if (auth.currentUser?.emailVerified) {
      stopVerifyPoll();
      toast('Email verified — welcome to StudyFlow', 'success');
      applyAuthState(auth.currentUser);
    }
  }

  function applyAuthState(user) {
    setCurrentUser(user);
    const verifyEl = document.getElementById('auth-verify');
    if (user && !user.emailVerified && user.providerData[0]?.providerId === 'password' && !isOrgEmail(user.email)) {
      // Email/password user who hasn't verified yet — show verification screen
      document.getElementById('auth-verify-email').textContent = user.email;
      authScreen.classList.remove('hidden');
      appWrapper.classList.add('hidden');
      document.getElementById('auth-loading').classList.add('hidden');
      document.getElementById('auth-card').classList.add('hidden');
      verifyEl.classList.remove('hidden');
      startVerifyPoll();
      return;
    }
    stopVerifyPoll();
    verifyEl.classList.add('hidden');
    if (user) {
      // Close any lingering modals before showing the app
      document.getElementById('settings-modal').classList.remove('modal--open');
      document.getElementById('hw-modal').classList.remove('modal--open');

      // Show app, hide auth screen
      authScreen.classList.add('hidden');
      appWrapper.classList.remove('hidden');

      // Re-apply prefs (theme/accent) every login — needed after logout clears data-theme
      applyPrefs();

      // Show avatar in header
      const avatar = document.getElementById('user-avatar');
      if (user.photoURL) { avatar.src = user.photoURL; avatar.alt = user.displayName || ''; }

      // Load data and boot app
      init();
    } else {
      // Reset theme so auth screen is always light/readable
      document.documentElement.removeAttribute('data-theme');

      // Show sign-in card, hide spinner
      appWrapper.classList.add('hidden');
      authScreen.classList.remove('hidden');
      authLoading.classList.add('hidden');
      authCard.classList.remove('hidden');
    }
  }

  // Firebase resolves auth state from cache — this fires in ~100ms for returning users
  auth.onAuthStateChanged(applyAuthState);
});
