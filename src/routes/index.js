const express = require('express');
const patientRoutes = require('./patientRoutes');
const batchRoutes = require('./batchRoutes');
const visitRoutes = require('./visitRoutes');
const journalRoutes = require('./journalRoutes');

const router = express.Router();

// Mount routes
router.use('/patients', patientRoutes);
router.use('/batches', batchRoutes);
router.use('/', visitRoutes);
router.use('/', journalRoutes);

module.exports = router;
