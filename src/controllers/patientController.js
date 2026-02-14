const patientService = require('../services/patientService');

const addPatient = async (req, res) => {
    try {
        const patientData = req.body;
        const newPatient = await patientService.addPatient(patientData);
        res.status(201).json(newPatient);
    } catch (error) {
        res.status(500).json({ message: 'Error adding patient', error: error.message });
    }
};

const getAllPatients = async (req, res) => {
    try {
        const { batch_id } = req.query;
        const patients = await patientService.getAllPatients(batch_id);
        res.status(200).json(patients);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving patients', error: error.message });
    }
};

const getPatientById = async (req, res) => {
    try {
        const { id } = req.params;
        const patient = await patientService.getPatientById(id);
        if (patient) {
            res.status(200).json(patient);
        } else {
            res.status(404).json({ message: 'Patient not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving patient', error: error.message });
    }
};

const checkDuplicates = async (req, res) => {
    try {
        const patientData = req.body;
        const duplicates = await patientService.checkDuplicates(patientData);
        res.status(200).json(duplicates);
    } catch (error) {
        res.status(500).json({ message: 'Error checking duplicates', error: error.message });
    }
};

const updatePatient = async (req, res) => {
    try {
        const { id } = req.params;
        const patientData = req.body;
        const updatedPatient = await patientService.updatePatient(id, patientData);
        res.status(200).json(updatedPatient);
    } catch (error) {
        res.status(500).json({ message: 'Error updating patient', error: error.message });
    }
};

const deletePatient = async (req, res) => {
    try {
        const { id } = req.params;
        await patientService.deletePatient(id);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: 'Error deleting patient', error: error.message });
    }
};

module.exports = {
    addPatient,
    getAllPatients,
    getPatientById,
    checkDuplicates,
    updatePatient,
    deletePatient
};
