const db = require('../config/database');

// Get all batches
const getAllBatches = () => {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM intake_batches ORDER BY created_at DESC';
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

// Create a new batch
const createBatch = (batchName) => {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT INTO intake_batches (batch_name) VALUES (?)';
        db.run(sql, [batchName], function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, batch_name: batchName });
        });
    });
};

// Get batch by ID
const getBatchById = (id) => {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM intake_batches WHERE id = ?';
        db.get(sql, [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

module.exports = {
    getAllBatches,
    createBatch,
    getBatchById
};
