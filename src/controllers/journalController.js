const journalService = require('../services/journalService');

const journalController = {
    async getEntries(req, res) {
        try {
            const { patientId } = req.params;
            const entries = await journalService.getEntriesByPatientId(patientId);
            res.json(entries);
        } catch (error) {
            res.status(500).json({ message: 'Error fetching journal entries', error: error.message });
        }
    },

    async addEntry(req, res) {
        try {
            const { patientId } = req.params;
            const entry = await journalService.addEntry(patientId, req.body);
            res.status(201).json(entry);
        } catch (error) {
            res.status(500).json({ message: 'Error adding journal entry', error: error.message });
        }
    },

    async deleteEntry(req, res) {
        try {
            const { entryId } = req.params;
            await journalService.deleteEntry(entryId);
            res.json({ message: 'Journal entry deleted' });
        } catch (error) {
            res.status(500).json({ message: 'Error deleting journal entry', error: error.message });
        }
    },

    async getTimeline(req, res) {
        try {
            const { patientId } = req.params;
            const timeline = await journalService.getPatientTimeline(patientId);
            res.json(timeline);
        } catch (error) {
            res.status(500).json({ message: 'Error fetching timeline', error: error.message });
        }
    }
};

module.exports = journalController;
