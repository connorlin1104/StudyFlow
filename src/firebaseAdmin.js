'use strict';
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('../serviceAccountKey.json'))
  });
}

module.exports = {
  db:         admin.firestore(),
  FieldValue: admin.firestore.FieldValue
};
