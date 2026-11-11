import { api } from './api.js';
import { prefs } from './prefs.js';
import { toast } from './utils.js';
import { renderPrefsPage } from './settings.js';

/* =============================================================================
   PUSH NOTIFICATIONS
   This half only registers the subscription; sw.js displays what arrives. The
   sending half can't live here — it has to run when the browser is closed — so
   it's a GitHub Actions cron, notifier/send-reminders.js.

   This key must stay in sync with the VAPID_PUBLIC_KEY secret that job signs
   with. Changing it invalidates every subscription already in Firestore, and
   each device has to toggle notifications off and back on.
   ============================================================================= */
const VAPID_PUBLIC_KEY = 'BKGl9PmZmTbSavV-2JK3Lh45XxxCkd3un6Gf8eK3hMbCFuvPsQ3wKagCChxP5qy0n6VVmfmtapaeeueImwOdjVY';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* An existing subscription reports its key as an ArrayBuffer. Treat "the browser
   didn't tell us" as a mismatch — resubscribing costs one round trip, while
   guessing wrong leaves a subscription no push can ever reach. */
function sameApplicationServerKey(existing, wanted) {
  if (!existing) return false;
  const bytes = new Uint8Array(existing);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (e) { console.warn('SW registration failed:', e); }
}

async function subscribeToNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = navigator.standalone === true;
    if (isIOS && !isStandalone) {
      toast('Tap the share icon → "Add to Home Screen", then open the app from your home screen to enable notifications.', 'warning');
    } else {
      toast('Push notifications are not supported in this browser.', 'warning');
    }
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Notification permission denied.', 'warning');
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    renderPrefsPage();
    return;
  }
  try {
    const reg    = await navigator.serviceWorker.ready;
    const appKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

    /* A subscription created under a different VAPID key can't be replaced by
       subscribing over it — the browser throws "Provided applicationServerKey
       does not match the key in the existing subscription". Toggling off would
       clear it, but that's no help to anyone whose toggle already reads off
       (a failed attempt leaves it that way), so retire the stale one here.
       Its Firestore document goes too: the endpoint is about to change, and
       nothing else would ever clean up the orphan. */
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameApplicationServerKey(sub.options?.applicationServerKey, appKey)) {
      try { await api.notifications.unsubscribe(sub.endpoint); } catch (_) {}
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: appKey
      });
    }
    const notifyBefore = prefs.get('notifyBefore', 60);
    await api.notifications.subscribe(sub.toJSON(), notifyBefore);
    prefs.set('notificationsEnabled', true);
    prefs.set('pushEndpoint', sub.endpoint);
    renderPrefsPage();
    toast('Notifications enabled', 'success');
  } catch (e) {
    toast(`Could not enable notifications: ${e.message}`, 'error');
    prefs.set('notificationsEnabled', false);
    document.getElementById('pref-notifications').checked = false;
    renderPrefsPage();
  }
}

async function unsubscribeFromNotifications() {
  try {
    const endpoint = prefs.get('pushEndpoint', null);
    if (endpoint) {
      await api.notifications.unsubscribe(endpoint);
    }
    const reg = await navigator.serviceWorker?.ready;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
    prefs.set('notificationsEnabled', false);
    prefs.set('pushEndpoint', null);
    renderPrefsPage();
    toast('Notifications disabled', 'success');
  } catch (e) { toast(`Error disabling notifications: ${e.message}`, 'error'); }
}

export { registerServiceWorker, subscribeToNotifications, unsubscribeFromNotifications };
