'use strict';

const { onRequest }  = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const express        = require('express');
const webpush        = require('web-push');

const tabRoutes           = require('./src/routes/tabs');
const classRoutes         = require('./src/routes/classes');
const homeworkRoutes      = require('./src/routes/homework');
const notificationRoutes  = require('./src/routes/notifications');
const errorHandler        = require('./src/middleware/errorHandler');
const requireAuth         = require('./src/middleware/auth');
const { db, FieldValue }  = require('./src/firebaseAdmin');

const VAPID_PUBLIC_KEY  = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_EMAIL       = defineSecret('VAPID_EMAIL');

const app = express();
app.use(express.json());

app.use('/api/tabs',          requireAuth, tabRoutes);
app.use('/api/classes',       requireAuth, classRoutes);
app.use('/api/homework',      requireAuth, homeworkRoutes);
app.use('/api/notifications', requireAuth, notificationRoutes);
app.use(errorHandler);

exports.api = onRequest({ invoker: 'public', secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL] }, app);

exports.scheduledNotifications = onSchedule(
  { schedule: 'every 15 minutes', secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL] },
  async () => {
    const toUrlSafe = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    webpush.setVapidDetails(
      VAPID_EMAIL.value(),
      toUrlSafe(VAPID_PUBLIC_KEY.value()),
      toUrlSafe(VAPID_PRIVATE_KEY.value())
    );

    const now      = Date.now();
    const window   = 15 * 60 * 1000; // 15 min in ms
    const todayStr = new Date().toISOString().slice(0, 10);

    const subsSnap = await db.collection('pushSubscriptions').get();
    if (subsSnap.empty) return;

    // Group subscriptions by uid
    const byUid = {};
    for (const doc of subsSnap.docs) {
      const s = doc.data();
      if (!byUid[s.uid]) byUid[s.uid] = [];
      byUid[s.uid].push({ id: doc.id, ...s });
    }

    for (const [uid, subs] of Object.entries(byUid)) {
      const hwSnap = await db.collection('users').doc(uid).collection('homework')
        .where('completed', '==', false)
        .where('deadline', '>=', todayStr)
        .get();

      for (const hwDoc of hwSnap.docs) {
        const item = hwDoc.data();
        if (!item.deadline) continue;
        if (item.remindedAt) continue;      // already notified
        if (item.remindBefore === -1) continue; // user opted out

        for (const sub of subs) {
          const remindMins = (item.remindBefore != null ? item.remindBefore : sub.notifyBefore) ?? 60;

          // Build deadline timestamp
          const timeStr  = item.deadlineTime || '23:59';
          const [hh, mm] = timeStr.split(':').map(Number);
          const [y, mo, d] = item.deadline.split('-').map(Number);
          const deadlineMs = new Date(y, mo - 1, d, hh, mm).getTime();
          const remindAt   = deadlineMs - remindMins * 60 * 1000;

          if (remindAt >= now - window && remindAt <= now) {
            // Find class name for the body
            let className = '';
            try {
              const clsDoc = await db.collection('users').doc(uid).collection('classes').doc(item.classId).get();
              if (clsDoc.exists) className = clsDoc.data().name;
            } catch (_) {}

            const minsLeft = Math.round((deadlineMs - now) / 60000);
            const body = minsLeft > 60
              ? `Due in ${Math.round(minsLeft / 60)} hr${minsLeft > 90 ? 's' : ''}${className ? ' · ' + className : ''}`
              : `Due in ${minsLeft} min${className ? ' · ' + className : ''}`;

            const payload = JSON.stringify({ title: item.description, body, url: '/' });

            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                payload
              );
              await hwDoc.ref.update({ remindedAt: FieldValue.serverTimestamp() });
            } catch (err) {
              if (err.statusCode === 410) {
                // Subscription expired — clean it up
                await db.collection('pushSubscriptions').doc(sub.id).delete();
              }
            }
          }
        }
      }
    }
  }
);
