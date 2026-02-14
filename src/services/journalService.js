const db = require('../config/database');

const journalService = {
    // Get all journal entries for a patient
    getEntriesByPatientId(patientId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM journal_entries WHERE patient_id = ? ORDER BY entry_date DESC, created_at DESC`;
            db.all(sql, [patientId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    },

    // Add a new journal entry
    addEntry(patientId, entryData) {
        return new Promise((resolve, reject) => {
            const { entry_type, title, content, created_by } = entryData;
            const sql = `INSERT INTO journal_entries (patient_id, entry_type, title, content, created_by, entry_date)
                         VALUES (?, ?, ?, ?, ?, datetime('now'))`;
            db.run(sql, [patientId, entry_type || 'note', title, content, created_by], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, patient_id: patientId, ...entryData });
            });
        });
    },

    // Delete a journal entry
    deleteEntry(entryId) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM journal_entries WHERE id = ?`;
            db.run(sql, [entryId], function(err) {
                if (err) reject(err);
                else resolve({ deleted: this.changes > 0 });
            });
        });
    },

    // Get recent activity for a patient (visits + journal entries combined)
    getPatientTimeline(patientId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 'visit' as type, id, visit_date as date, chief_complaint as title, 
                       diagnosis as content, created_at 
                FROM visits WHERE patient_id = ?
                UNION ALL
                SELECT 'journal' as type, id, entry_date as date, title, content, created_at 
                FROM journal_entries WHERE patient_id = ?
                ORDER BY date DESC, created_at DESC
                LIMIT 20
            `;
            db.all(sql, [patientId, patientId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }
};

module.exports = journalService;
