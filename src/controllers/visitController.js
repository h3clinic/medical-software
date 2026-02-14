const visitService = require('../services/visitService');

// Get all visits for a patient
const getPatientVisits = async (req, res) => {
    try {
        const { id } = req.params;
        const visits = await visitService.getVisitsByPatientId(id);
        res.status(200).json(visits);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving visits', error: error.message });
    }
};

// Add a new visit for a patient
const addVisit = async (req, res) => {
    try {
        const { id } = req.params;
        const visitData = req.body;
        const newVisit = await visitService.addVisit(id, visitData);
        res.status(201).json(newVisit);
    } catch (error) {
        res.status(500).json({ message: 'Error adding visit', error: error.message });
    }
};

// Delete a visit
const deleteVisit = async (req, res) => {
    try {
        const { visitId } = req.params;
        const result = await visitService.deleteVisit(visitId);
        if (result.deleted) {
            res.status(200).json({ message: 'Visit deleted successfully' });
        } else {
            res.status(404).json({ message: 'Visit not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error deleting visit', error: error.message });
    }
};

module.exports = {
    getPatientVisits,
    addVisit,
    deleteVisit
};
