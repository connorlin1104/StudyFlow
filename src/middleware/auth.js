'use strict';
const admin = require('firebase-admin');
require('../firebaseAdmin'); // ensure initialized

module.exports = async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
