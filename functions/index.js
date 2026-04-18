'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const express       = require('express');

const tabRoutes      = require('./src/routes/tabs');
const classRoutes    = require('./src/routes/classes');
const homeworkRoutes = require('./src/routes/homework');
const errorHandler   = require('./src/middleware/errorHandler');
const requireAuth    = require('./src/middleware/auth');

const app = express();
app.use(express.json());

app.use('/api/tabs',     requireAuth, tabRoutes);
app.use('/api/classes',  requireAuth, classRoutes);
app.use('/api/homework', requireAuth, homeworkRoutes);
app.use(errorHandler);

exports.api = onRequest({ invoker: 'public' }, app);
