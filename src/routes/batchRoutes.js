const express = require('express');
const batchController = require('../controllers/batchController');

const router = express.Router();

router.get('/', batchController.getAllBatches);
router.post('/', batchController.createBatch);

module.exports = router;
