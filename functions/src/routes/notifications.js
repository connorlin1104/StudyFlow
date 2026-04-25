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
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const snap = await col().where('uid', '==', req.uid)
                            .where('endpoint', '==', endpoint)
                            .limit(1).get();
    if (!snap.empty) await snap.docs[0].ref.delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/test', async (req, res) => {
  try {
    const webpush = require('web-push');
    if (!process.env.VAPID_EMAIL || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(500).json({ error: 'VAPID keys not configured.' });
    }
    const toUrlSafe = s => s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL,
      toUrlSafe(process.env.VAPID_PUBLIC_KEY),
      toUrlSafe(process.env.VAPID_PRIVATE_KEY)
    );

    const subsSnap = await col().where('uid', '==', req.uid).get();
    if (subsSnap.empty) return res.status(400).json({ error: 'No subscription found. Enable notifications first.' });

    const payload = JSON.stringify({ title: 'StudyFlow', body: 'Notifications are working!', url: '/' });
    for (const doc of subsSnap.docs) {
      const sub = doc.data();
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (e) {
        if (e.statusCode === 410) await doc.ref.delete();
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
