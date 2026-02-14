const express = require('express');
const visitController = require('../controllers/visitController');

const router = express.Router();

// GET /api/patients/:id/visits - Get all visits for a patient
router.get('/patients/:id/visits', visitController.getPatientVisits);

// POST /api/patients/:id/visits - Add a visit for a patient
router.post('/patients/:id/visits', visitController.addVisit);

// DELETE /api/visits/:visitId - Delete a visit
router.delete('/visits/:visitId', visitController.deleteVisit);

module.exports = router;
