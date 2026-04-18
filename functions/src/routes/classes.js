'use strict';
const express            = require('express');
const router             = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');

const col = uid      => db.collection('users').doc(uid).collection('classes');
const doc = (uid, id) => col(uid).doc(id);

router.get('/', async (req, res) => {
  try {
    const snap    = await col(req.uid).get();
    const classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    classes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    res.json(classes);
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
  const { name, color, teacher, room, period, tabId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const data = {
      tabId:   tabId   || 'classes',
      name:    name.trim(),
      color:   color   || '#3b82f6',
      order:   Date.now(),
      createdAt: FieldValue.serverTimestamp()
    };
    if (teacher) data.teacher = teacher;
    if (room)    data.room    = room;
    if (period)  data.period  = period;
    const ref = await col(req.uid).add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { name, color, teacher, room, period } = req.body;
  try {
    const ref    = doc(req.uid, req.params.id);
    const update = {};
    if (name    !== undefined) update.name    = name;
    if (color   !== undefined) update.color   = color;
    if (teacher !== undefined) update.teacher = teacher;
    if (room    !== undefined) update.room    = room;
    if (period  !== undefined) update.period  = period;
    await ref.update(update);
    const snap = await ref.get();
    res.json({ id: snap.id, ...snap.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const uid    = req.uid;
    const clsId  = req.params.id;
    const hwSnap = await db.collection('users').doc(uid).collection('homework')
      .where('classId', '==', clsId).get();
    const batch  = db.batch();
    batch.delete(doc(uid, clsId));
    hwSnap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
