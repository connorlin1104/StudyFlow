'use strict';
const express            = require('express');
const router             = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');

const col = uid      => db.collection('users').doc(uid).collection('homework');
const doc = (uid, id) => col(uid).doc(id);

router.get('/', async (req, res) => {
  try {
    let query = col(req.uid);
    if (req.query.classId) query = query.where('classId', '==', req.query.classId);
    const snap = await query.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { classId, description, notes, deadline, deadlineTime } = req.body;
  if (!classId || !description?.trim()) {
    return res.status(400).json({ error: 'classId and description are required' });
  }
  try {
    const data = {
      classId,
      description: description.trim(),
      completed:   false,
      createdAt:   FieldValue.serverTimestamp()
    };
    if (notes)        data.notes        = notes;
    if (deadline)     data.deadline     = deadline;
    if (deadlineTime) data.deadlineTime = deadlineTime;
    const ref = await col(req.uid).add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { description, notes, deadline, deadlineTime, completed } = req.body;
  try {
    const ref    = doc(req.uid, req.params.id);
    const update = {};
    if (description  !== undefined) update.description  = description;
    if (notes        !== undefined) update.notes        = notes;
    if (deadline     !== undefined) update.deadline     = deadline;
    if (deadlineTime !== undefined) update.deadlineTime = deadlineTime;
    if (completed    !== undefined) update.completed    = completed;
    await ref.update(update);
    const snap = await ref.get();
    res.json({ id: snap.id, ...snap.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await doc(req.uid, req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
