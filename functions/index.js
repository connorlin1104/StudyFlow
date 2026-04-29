'use strict';
// v3
const { onRequest }  = require('firebase-functions/v2/https');
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

// Internal endpoint called by Cloud Tasks — no user auth, verified by queue header
app.post('/internal/notify', async (req, res) => {
  if (!req.headers['x-cloudtasks-queuename']) return res.status(403).send('Forbidden');
  const { uid, hwId } = req.body;
  if (!uid || !hwId) return res.status(400).send('Missing uid or hwId');
  try {
    const toUrlSafe = s => s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL.trim(),
      toUrlSafe(process.env.VAPID_PUBLIC_KEY),
      toUrlSafe(process.env.VAPID_PRIVATE_KEY)
    );

    const hwRef = db.collection('users').doc(uid).collection('homework').doc(hwId);
    const hwDoc = await hwRef.get();
    if (!hwDoc.exists) return res.sendStatus(200);

    const item = hwDoc.data();
    if (item.completed || item.remindBefore === -1 || item.remindedAt) return res.sendStatus(200);

    const subsSnap = await db.collection('pushSubscriptions').where('uid', '==', uid).get();
    if (subsSnap.empty) return res.sendStatus(200);

    let className = '';
    try {
      const clsDoc = await db.collection('users').doc(uid).collection('classes').doc(item.classId).get();
      if (clsDoc.exists) className = clsDoc.data().name;
    } catch (_) {}

    const now = Date.now();
    const deadlineMs = item.deadlineMs ?? (() => {
      const [hh, mm] = (item.deadlineTime || '23:59').split(':').map(Number);
      const [y, mo, d] = item.deadline.split('-').map(Number);
      return new Date(Date.UTC(y, mo - 1, d, hh, mm)).getTime();
    })();
    const minsLeft = Math.round((deadlineMs - now) / 60000);
    const body = minsLeft > 60
      ? `Due in ${Math.round(minsLeft / 60)} hr${minsLeft > 90 ? 's' : ''}${className ? ' · ' + className : ''}`
      : `Due in ${minsLeft} min${className ? ' · ' + className : ''}`;

    const payload = JSON.stringify({ title: item.description, body, url: '/' });
    for (const doc of subsSnap.docs) {
      const sub = doc.data();
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (err) {
        if (err.statusCode === 410) await doc.ref.delete();
      }
    }
    await hwRef.update({ remindedAt: FieldValue.serverTimestamp() });
    res.sendStatus(200);
  } catch (e) {
    console.error('internal/notify error:', e);
    res.status(500).send(e.message);
  }
});

app.use('/api/tabs',          requireAuth, tabRoutes);
app.use('/api/classes',       requireAuth, classRoutes);
app.use('/api/homework',      requireAuth, homeworkRoutes);
app.use('/api/notifications', requireAuth, notificationRoutes);
app.use(errorHandler);

exports.api = onRequest({ invoker: 'public', secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL] }, app);

// Scheduled cleanup: delete completed homework items older than 30 days
const { onSchedule } = require('firebase-functions/v2/scheduler');
exports.cleanup = onSchedule('every 24 hours', async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const snap = await db.collectionGroup('homework')
      .where('completed', '==', true)
      .where('completedAt', '<=', cutoff)
      .get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  } catch (_) {}
});
