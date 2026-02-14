const batchService = require('../services/batchService');

const getAllBatches = async (req, res) => {
    try {
        const batches = await batchService.getAllBatches();
        res.status(200).json(batches);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving batches', error: error.message });
    }
};

const createBatch = async (req, res) => {
    try {
        const { batch_name } = req.body;
        if (!batch_name) {
            return res.status(400).json({ message: 'batch_name is required' });
        }
        const newBatch = await batchService.createBatch(batch_name);
        res.status(201).json(newBatch);
    } catch (error) {
        res.status(500).json({ message: 'Error creating batch', error: error.message });
    }
};

module.exports = {
    getAllBatches,
    createBatch
};
