'use strict';
const express = require('express');
const router  = express.Router();
const { db, FieldValue } = require('../firebaseAdmin');

router.post('/', async (req, res) => {
  const { subject, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    await db.collection('supportMessages').add({
      uid:       req.uid,
      subject:   subject || 'General',
      message:   message.trim(),
      createdAt: FieldValue.serverTimestamp(),
      read:      false
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
