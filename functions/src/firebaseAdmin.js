'use strict';
const admin = require('firebase-admin');

// In Cloud Functions, initializeApp() uses the built-in service account automatically.
if (!admin.apps.length) admin.initializeApp();

module.exports = {
  db:         admin.firestore(),
  FieldValue: admin.firestore.FieldValue
};
