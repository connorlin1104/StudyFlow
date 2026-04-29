'use strict';
const express            = require('express');
const router             = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');
const { scheduleNotification, cancelTask } = require('../taskHelper');

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
  const { classId, description, notes, deadline, deadlineTime, deadlineMs, remindBefore } = req.body;
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
    if (notes)                    data.notes        = notes;
    if (deadline)                 data.deadline     = deadline;
    if (deadlineTime)             data.deadlineTime = deadlineTime;
    if (remindBefore !== undefined && remindBefore !== null) data.remindBefore = remindBefore;
    if (deadlineMs   != null) data.deadlineMs = deadlineMs;
    const ref = await col(req.uid).add(data);

    const notifyTaskName = await scheduleNotification(req.uid, ref.id, data);
    if (notifyTaskName) await ref.update({ notifyTaskName });

    res.status(201).json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { description, notes, deadline, deadlineTime, deadlineMs, completed, remindBefore } = req.body;
  try {
    const ref      = doc(req.uid, req.params.id);
    const existing = (await ref.get()).data() || {};
    const update   = {};
    if (description  !== undefined) update.description  = description;
    if (notes        !== undefined) update.notes        = notes;
    if (deadline     !== undefined) update.deadline     = deadline;
    if (deadlineTime !== undefined) update.deadlineTime = deadlineTime;
    if (completed    !== undefined) {
      update.completed   = completed;
      update.completedAt = completed ? FieldValue.serverTimestamp() : null;
    }
    if (remindBefore !== undefined) update.remindBefore = remindBefore;
    if (deadlineMs   !== undefined) update.deadlineMs   = deadlineMs;
    if ((deadline !== undefined && deadline !== existing.deadline) ||
        (deadlineTime !== undefined && deadlineTime !== existing.deadlineTime)) {
      update.remindedAt = null;
    }
    await ref.update(update);

    const needsReschedule = deadline !== undefined || deadlineTime !== undefined ||
                            remindBefore !== undefined || completed !== undefined;
    if (needsReschedule) {
      const merged = { ...existing, ...update };
      const notifyTaskName = merged.completed
        ? (await cancelTask(existing.notifyTaskName), null)
        : await scheduleNotification(req.uid, req.params.id, { ...merged, notifyTaskName: existing.notifyTaskName });
      await ref.update({ notifyTaskName: notifyTaskName ?? null });
    }

    const snap = await ref.get();
    res.json({ id: snap.id, ...snap.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = (await doc(req.uid, req.params.id).get()).data() || {};
    await cancelTask(existing.notifyTaskName);
    await doc(req.uid, req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
