const express = require('express');
const router = express.Router();
const journalController = require('../controllers/journalController');

// GET /patients/:patientId/journal - Get all journal entries
router.get('/patients/:patientId/journal', journalController.getEntries);

// POST /patients/:patientId/journal - Add new journal entry
router.post('/patients/:patientId/journal', journalController.addEntry);

// DELETE /journal/:entryId - Delete a journal entry
router.delete('/journal/:entryId', journalController.deleteEntry);

// GET /patients/:patientId/timeline - Get combined timeline (visits + journal)
router.get('/patients/:patientId/timeline', journalController.getTimeline);

module.exports = router;
