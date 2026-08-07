'use strict';

/* =============================================================================
   REMINDER SENDER
   The one piece of StudyFlow that cannot live in the browser: something has to
   be awake when the browser isn't. Cloud Functions used to do this (a Cloud Task
   per assignment, scheduled at its remind time); they died with the move to the
   Spark plan and were deleted in 2b9b732, which is why enabling notifications
   wrote a valid subscription that nothing ever read.

   This replaces that design with a periodic scan. Instead of one timer per
   assignment, GitHub Actions runs this every 15 minutes and it asks "what should
   have fired since last time?". Less precise than a per-item task, but it has no
   scheduling state to get out of sync, and a missed run self-heals on the next
   one rather than dropping the reminder forever.

   Only users who actually have a push subscription are scanned, so the read cost
   is proportional to subscribers rather than to the whole database — and it stays
   inside the Spark plan's free daily quota.
   ============================================================================= */

const admin   = require('firebase-admin');
const webpush = require('web-push');

/* Sending late is better than not sending at all — GitHub's scheduled workflows
   are routinely minutes late and occasionally skipped — but there's a point past
   which a reminder is just noise. Past this, the assignment is marked as
   reminded without a push, so a run after an outage doesn't dump a pile of
   stale notifications. */
const MAX_LATE_MS = Number(process.env.MAX_LATE_MINUTES ?? 360) * 60 * 1000;

/* Only used for assignments saved before the client started storing deadlineMs.
   Those have a wall-clock date and time with no timezone, so we need to know
   whose wall clock. */
const FALLBACK_TZ = process.env.DEFAULT_TIMEZONE ?? 'America/Los_Angeles';

const DRY_RUN = process.env.DRY_RUN === 'true';

/* -----------------------------------------------------------------------------
   SETUP
   -------------------------------------------------------------------------- */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/* The old backend accepted VAPID keys pasted with standard-base64 characters and
   trailing padding; the web-push library wants url-safe and unpadded. Keep that
   normalisation so a key copied out of the old Functions config still works. */
const toUrlSafe = s => s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

function init() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT')))
  });
  webpush.setVapidDetails(
    requireEnv('VAPID_EMAIL').trim(),
    toUrlSafe(requireEnv('VAPID_PUBLIC_KEY')),
    toUrlSafe(requireEnv('VAPID_PRIVATE_KEY'))
  );
  return admin.firestore();
}

/* -----------------------------------------------------------------------------
   DEADLINES
   -------------------------------------------------------------------------- */

/* How far `timeZone` sits from UTC at a given instant, DST included. */
function tzOffsetMs(ts, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day:    '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ts)).map(p => [p.type, p.value])
  );
  // Some ICU builds render midnight as hour 24 rather than 0.
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                         +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - ts;
}

/* Wall-clock date/time in `timeZone` → epoch ms. Guess that the local time is
   UTC, then subtract whatever offset that guess actually lands in; re-check once
   so an instant that straddles a DST change resolves to the right side of it. */
function wallClockToEpoch(dateStr, timeStr, timeZone) {
  const [y, mo, d]  = dateStr.split('-').map(Number);
  const [hh, mm]    = (timeStr || '00:00').split(':').map(Number);
  const guess       = Date.UTC(y, mo - 1, d, hh, mm);
  const firstOffset = tzOffsetMs(guess, timeZone);
  const ts          = guess - firstOffset;
  const trueOffset  = tzOffsetMs(ts, timeZone);
  return trueOffset === firstOffset ? ts : guess - trueOffset;
}

/* deadlineMs is written by the client from the user's own clock, so prefer it —
   it already carries the timezone the assignment was created in. The fallback
   matches how the client computes deadlineMs (a bare date means midnight, not
   end of day) so old and new assignments fire at a consistent time. */
function deadlineEpoch(hw) {
  if (typeof hw.deadlineMs === 'number') return hw.deadlineMs;
  if (!hw.deadline) return null;
  return wallClockToEpoch(hw.deadline, hw.deadlineTime, FALLBACK_TZ);
}

/* -----------------------------------------------------------------------------
   MESSAGE
   -------------------------------------------------------------------------- */
function formatLead(dueMs, now) {
  const diff = dueMs - now;
  // A 15-minute scan almost never lands exactly on an "At deadline" reminder, so
  // treat the minute either side of the deadline as "now" rather than "overdue".
  if (diff <= -60000)        return 'overdue';
  const mins = Math.round(diff / 60000);
  if (mins < 2)              return 'now';
  if (mins < 60)             return `in ${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 24)            return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function buildPayload(hw, className, dueMs, now) {
  const title = hw.description?.length > 60
    ? `${hw.description.slice(0, 59)}…`
    : (hw.description || 'Assignment due');
  const lead = formatLead(dueMs, now);
  return JSON.stringify({
    title,
    body: className ? `${className} · due ${lead}` : `Due ${lead}`,
    url:  '/'
  });
}

/* -----------------------------------------------------------------------------
   SENDING
   -------------------------------------------------------------------------- */

/* Returns true if the assignment should be marked as reminded. A subscription
   the push service has retired (404/410) is deleted rather than retried; if
   every subscription for the user turns out to be dead we still mark it, since
   there is no longer anyone to notify. Any other failure leaves the assignment
   untouched so the next run tries again. */
async function pushToAll(subs, payload) {
  let delivered = 0;
  let stale     = 0;
  let lastError = null;

  for (const sub of subs) {
    const { endpoint, keys } = sub.data();
    try {
      await webpush.sendNotification({ endpoint, keys }, payload, { TTL: 3600 });
      delivered++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log(`  · dropping expired subscription …${endpoint.slice(-24)}`);
        await sub.ref.delete();
        stale++;
      } else {
        lastError = err;
        console.error(`  · push failed (${err.statusCode ?? '?'}) …${endpoint.slice(-24)}: ${err.body ?? err.message}`);
      }
    }
  }
  return { sent: delivered, settled: delivered > 0 || (stale > 0 && !lastError) };
}

/* -----------------------------------------------------------------------------
   MAIN
   -------------------------------------------------------------------------- */
async function processUser(db, uid, subs, now) {
  /* notifyBefore is a per-user default that the client mirrors onto every
     subscription; userPrefs is the source of truth, a subscription is the
     migration fallback for users who set it before userPrefs existed. */
  const prefDoc  = await db.collection('userPrefs').doc(uid).get();
  const fallback = subs[0]?.data().notifyBefore;
  const userDefault = prefDoc.exists && prefDoc.data().notifyBefore != null
    ? prefDoc.data().notifyBefore
    : (fallback ?? 60);

  const [hwSnap, classSnap] = await Promise.all([
    db.collection('users').doc(uid).collection('homework').get(),
    db.collection('users').doc(uid).collection('classes').get()
  ]);
  const classNames = new Map(classSnap.docs.map(d => [d.id, d.data().name]));

  let sent = 0;
  for (const doc of hwSnap.docs) {
    const hw = doc.data();

    if (hw.completed)        continue;
    if (hw.remindedAt)       continue;   // already fired; cleared when the deadline changes
    if (!hw.deadline)        continue;

    const remindBefore = hw.remindBefore ?? userDefault;
    if (remindBefore === -1) continue;   // "No reminder"

    const dueMs = deadlineEpoch(hw);
    if (dueMs == null) continue;

    const remindAt = dueMs - remindBefore * 60000;
    if (now < remindAt) continue;        // not yet — a later run will catch it

    const late = now - remindAt;
    if (late > MAX_LATE_MS) {
      /* Too old to be useful. Marking it stops the same assignment being
         reconsidered on every future run. This is also what suppresses
         reminders on assignments created with an already-past deadline. */
      if (!DRY_RUN) await doc.ref.update({ remindedAt: admin.firestore.FieldValue.serverTimestamp() });
      continue;
    }

    const label = `${hw.description ?? doc.id}`.slice(0, 50);
    if (DRY_RUN) {
      console.log(`  [dry run] would remind: "${label}" due ${new Date(dueMs).toISOString()} (${Math.round(late / 60000)}m late)`);
      sent++;
      continue;
    }

    console.log(`  → "${label}" due ${new Date(dueMs).toISOString()}`);
    const payload = buildPayload(hw, classNames.get(hw.classId), dueMs, now);
    const { sent: delivered, settled } = await pushToAll(subs, payload);
    if (settled) {
      await doc.ref.update({ remindedAt: admin.firestore.FieldValue.serverTimestamp() });
      sent += delivered;
    }
  }
  return sent;
}

/* A manual escape hatch for "is this thing on?" — the old /api/notifications/test
   endpoint, which the settings page still has a commented-out button for. Run it
   from the Actions tab rather than waiting for a real deadline. */
async function sendTest(subsByUid) {
  const payload = JSON.stringify({
    title: 'StudyFlow',
    body:  'Notifications are working!',
    url:   '/'
  });
  let sent = 0;
  for (const [uid, subs] of subsByUid) {
    console.log(`Test push → ${uid} (${subs.length} subscription${subs.length === 1 ? '' : 's'})`);
    const result = await pushToAll(subs, payload);
    sent += result.sent;
  }
  return sent;
}

async function main() {
  const db  = init();
  const now = Date.now();

  const subSnap = await db.collection('pushSubscriptions').get();
  if (subSnap.empty) {
    console.log('No push subscriptions registered — nothing to do.');
    return;
  }

  const subsByUid = new Map();
  for (const doc of subSnap.docs) {
    const { uid, endpoint, keys } = doc.data();
    if (!uid || !endpoint || !keys) {
      console.warn(`Skipping malformed subscription ${doc.id}`);
      continue;
    }
    if (!subsByUid.has(uid)) subsByUid.set(uid, []);
    subsByUid.get(uid).push(doc);
  }

  if (process.env.MODE === 'test') {
    const sent = await sendTest(subsByUid);
    console.log(`Test complete — ${sent} notification${sent === 1 ? '' : 's'} delivered.`);
    return;
  }

  console.log(`Scanning ${subsByUid.size} subscribed user${subsByUid.size === 1 ? '' : 's'}${DRY_RUN ? ' (dry run)' : ''}…`);
  let total = 0;
  for (const [uid, subs] of subsByUid) {
    console.log(`User ${uid} (${subs.length} subscription${subs.length === 1 ? '' : 's'})`);
    total += await processUser(db, uid, subs, now);
  }
  console.log(`Done — ${total} notification${total === 1 ? '' : 's'} ${DRY_RUN ? 'would be sent' : 'delivered'}.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for tests; the deadline maths and the "should this fire?" filter are
// the parts worth checking directly.
module.exports = { wallClockToEpoch, deadlineEpoch, formatLead, toUrlSafe, processUser };
