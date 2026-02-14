const db = require('../config/database');

// Add a new patient
const addPatient = (patientData) => {
    return new Promise((resolve, reject) => {
        const { 
            name, date_of_birth, age, gender, contact, email, address,
            source_file_id, intake_batch_id, scanned_by, intake_notes, 
            has_unknown_fields, intake_checklist 
        } = patientData;
        
        const now = new Date().toISOString();
        const sql = `INSERT INTO patients (
            name, date_of_birth, age, gender, contact, email, address,
            source_file_id, intake_batch_id, scanned_by, intake_notes,
            has_unknown_fields, intake_checklist, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        db.run(sql, [
            name, date_of_birth, age, gender, contact, email, address,
            source_file_id, intake_batch_id, scanned_by, intake_notes,
            has_unknown_fields || 0, intake_checklist, now, now
        ], function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, ...patientData, created_at: now });
        });
    });
};

// Get all patients (with optional batch filter)
const getAllPatients = (batchId = null) => {
    return new Promise((resolve, reject) => {
        let sql = `SELECT p.*, b.batch_name 
                   FROM patients p 
                   LEFT JOIN intake_batches b ON p.intake_batch_id = b.id`;
        const params = [];
        
        if (batchId) {
            sql += ' WHERE p.intake_batch_id = ?';
            params.push(batchId);
        }
        sql += ' ORDER BY p.created_at DESC';
        
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

// Get patient by ID
const getPatientById = (id) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT p.*, b.batch_name 
                     FROM patients p 
                     LEFT JOIN intake_batches b ON p.intake_batch_id = b.id 
                     WHERE p.id = ?`;
        db.get(sql, [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

// Check for duplicates
const checkDuplicates = (patientData) => {
    return new Promise((resolve, reject) => {
        const { name, date_of_birth, contact, email } = patientData;
        
        let conditions = [];
        let params = [];
        
        if (name && date_of_birth) {
            conditions.push('(name = ? AND date_of_birth = ?)');
            params.push(name, date_of_birth);
        }
        if (contact) {
            conditions.push('(contact = ? AND contact IS NOT NULL AND contact != "")');
            params.push(contact);
        }
        if (email) {
            conditions.push('(email = ? AND email IS NOT NULL AND email != "")');
            params.push(email);
        }
        
        if (conditions.length === 0) {
            return resolve([]);
        }
        
        const sql = `SELECT id, name, date_of_birth, contact, email 
                     FROM patients 
                     WHERE ${conditions.join(' OR ')}`;
        
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

// Update patient
const updatePatient = (id, patientData) => {
    return new Promise((resolve, reject) => {
        const { 
            name, date_of_birth, age, gender, contact, email, address,
            source_file_id, intake_batch_id, scanned_by, intake_notes,
            has_unknown_fields, intake_checklist 
        } = patientData;
        
        const now = new Date().toISOString();
        const sql = `UPDATE patients SET 
            name = ?, date_of_birth = ?, age = ?, gender = ?, contact = ?, 
            email = ?, address = ?, source_file_id = ?, intake_batch_id = ?,
            scanned_by = ?, intake_notes = ?, has_unknown_fields = ?,
            intake_checklist = ?, updated_at = ?
            WHERE id = ?`;
        
        db.run(sql, [
            name, date_of_birth, age, gender, contact, email, address,
            source_file_id, intake_batch_id, scanned_by, intake_notes,
            has_unknown_fields || 0, intake_checklist, now, id
        ], function (err) {
            if (err) return reject(err);
            resolve({ id, ...patientData, updated_at: now });
        });
    });
};

// Delete patient
const deletePatient = (id) => {
    return new Promise((resolve, reject) => {
        const sql = 'DELETE FROM patients WHERE id = ?';
        db.run(sql, [id], function (err) {
            if (err) return reject(err);
            resolve({ deletedId: id });
        });
    });
};

module.exports = {
    addPatient,
    getAllPatients,
    getPatientById,
    checkDuplicates,
    updatePatient,
    deletePatient,
};
