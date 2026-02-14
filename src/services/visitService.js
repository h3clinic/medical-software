const db = require('../config/database');

// Get all visits for a patient
const getVisitsByPatientId = (patientId) => {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC';
        db.all(sql, [patientId], (err, rows) => {
            if (err) {
                return reject(err);
            }
            resolve(rows);
        });
    });
};

// Add a new visit
const addVisit = (patientId, visitData) => {
    return new Promise((resolve, reject) => {
        const { visit_date, chief_complaint, vitals_json, assessment, diagnosis, plan } = visitData;
        const sql = `INSERT INTO visits (patient_id, visit_date, chief_complaint, vitals_json, assessment, diagnosis, plan)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [patientId, visit_date, chief_complaint, vitals_json, assessment, diagnosis, plan], function (err) {
            if (err) {
                return reject(err);
            }
            resolve({ id: this.lastID, patient_id: patientId, ...visitData });
        });
    });
};

// Delete a visit
const deleteVisit = (visitId) => {
    return new Promise((resolve, reject) => {
        const sql = 'DELETE FROM visits WHERE id = ?';
        db.run(sql, [visitId], function (err) {
            if (err) {
                return reject(err);
            }
            resolve({ deleted: this.changes > 0 });
        });
    });
};

// Get a single visit by ID
const getVisitById = (visitId) => {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM visits WHERE id = ?';
        db.get(sql, [visitId], (err, row) => {
            if (err) {
                return reject(err);
            }
            resolve(row);
        });
    });
};

module.exports = {
    getVisitsByPatientId,
    addVisit,
    deleteVisit,
    getVisitById
};
