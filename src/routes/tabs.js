'use strict';
const express          = require('express');
const router           = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');

const col = uid     => db.collection('users').doc(uid).collection('tabs');
const doc = (uid, id) => col(uid).doc(id);

router.get('/', async (req, res) => {
  try {
    const snap = await col(req.uid).get();
    const tabs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tabs.sort((a, b) => {
      if (a.order != null && b.order != null) return a.order - b.order;
      if (a.order != null) return -1;
      if (b.order != null) return 1;
      return (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0);
    });
    res.json(tabs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Must appear before /:id routes
router.post('/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of IDs' });
  try {
    const batch = db.batch();
    order.forEach((id, index) => batch.update(doc(req.uid, id), { order: index }));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const ref = await col(req.uid).add({
      name: name.trim(),
      type: 'custom',
      createdAt: FieldValue.serverTimestamp()
    });
    res.status(201).json({ id: ref.id, name: name.trim(), type: 'custom' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { name } = req.body;
  try {
    const ref = doc(req.uid, req.params.id);
    await ref.update({ name });
    const snap = await ref.get();
    res.json({ id: snap.id, ...snap.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const uid    = req.uid;
    const tabId  = req.params.id;
    const clsSnap = await db.collection('users').doc(uid).collection('classes')
      .where('tabId', '==', tabId).get();
    const clsIds = clsSnap.docs.map(d => d.id);
    const batch  = db.batch();
    batch.delete(doc(uid, tabId));
    clsSnap.docs.forEach(d => batch.delete(d.ref));
    for (let i = 0; i < clsIds.length; i += 10) {
      const chunk  = clsIds.slice(i, i + 10);
      const hwSnap = await db.collection('users').doc(uid).collection('homework')
        .where('classId', 'in', chunk).get();
      hwSnap.docs.forEach(d => batch.delete(d.ref));
    }
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
