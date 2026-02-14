const express = require('express');
const patientController = require('../controllers/patientController');

const router = express.Router();

router.post('/check-duplicates', patientController.checkDuplicates);
router.post('/', patientController.addPatient);
router.get('/', patientController.getAllPatients);
router.get('/:id', patientController.getPatientById);
router.put('/:id', patientController.updatePatient);
router.delete('/:id', patientController.deletePatient);

module.exports = router;
