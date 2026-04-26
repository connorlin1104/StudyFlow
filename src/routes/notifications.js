'use strict';
const express    = require('express');
const router     = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');

const col = () => db.collection('pushSubscriptions');

router.post('/subscribe', async (req, res) => {
  const { subscription, notifyBefore } = req.body;
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'subscription object required' });
  }
  try {
    const snap = await col().where('uid', '==', req.uid)
                            .where('endpoint', '==', subscription.endpoint)
                            .limit(1).get();
    const data = {
      uid:          req.uid,
      endpoint:     subscription.endpoint,
      keys:         subscription.keys,
      notifyBefore: notifyBefore ?? 60,
      createdAt:    FieldValue.serverTimestamp()
    };
    if (!snap.empty) {
      await snap.docs[0].ref.update({ notifyBefore: data.notifyBefore });
      res.json({ id: snap.docs[0].id });
    } else {
      const ref = await col().add(data);
      res.status(201).json({ id: ref.id });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/subscribe', async (req, res) => {
  const { endpoint, notifyBefore } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const snap = await col().where('uid', '==', req.uid)
                            .where('endpoint', '==', endpoint)
                            .limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'subscription not found' });
    await snap.docs[0].ref.update({ notifyBefore: notifyBefore ?? 60 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/subscribe', async (req, res) => {
  try {
    const snap = await col().where('uid', '==', req.uid).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test endpoint: immediately runs the notification check for the current user only
// Call from browser console: apiFetch('POST', '/api/notifications/test', {})
router.post('/test', async (req, res) => {
  try {
  const webpush = require('web-push');
  if (!process.env.VAPID_EMAIL || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured. Set VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY env vars.' });
  }
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const now      = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);

  const subsSnap = await col().where('uid', '==', req.uid).get();
  if (subsSnap.empty) return res.status(400).json({ error: 'No subscription found. Enable notifications first.' });

  const subs = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const hwSnap = await db.collection('users').doc(req.uid).collection('homework')
    .where('completed', '==', false)
    .where('deadline', '>=', todayStr)
    .get();

  const sent = [];
  for (const hwDoc of hwSnap.docs) {
    const item = hwDoc.data();
    if (!item.deadline || item.remindBefore === -1) continue;

    for (const sub of subs) {
      const remindMins = (item.remindBefore != null ? item.remindBefore : sub.notifyBefore) ?? 60;
      const timeStr  = item.deadlineTime || '23:59';
      const [hh, mm] = timeStr.split(':').map(Number);
      const [y, mo, d] = item.deadline.split('-').map(Number);
      const deadlineMs = new Date(y, mo - 1, d, hh, mm).getTime();
      const minsLeft   = Math.round((deadlineMs - now) / 60000);
      const body = `Test · Due in ${minsLeft > 60 ? Math.round(minsLeft/60)+'hr' : minsLeft+'min'}`;

      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: item.description, body, url: '/' })
        );
        sent.push(item.description);
      } catch (e) {
        if (e.statusCode === 410) await db.collection('pushSubscriptions').doc(sub.id).delete();
      }
    }
  }
  res.json({ sent, count: sent.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
