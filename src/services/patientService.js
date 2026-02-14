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

// Merge extraction data into patient chart
const mergeExtractionIntoChart = (patientId, extractionData) => {
    return new Promise(async (resolve, reject) => {
        try {
            // Get current patient data
            const patient = await getPatientById(patientId);
            if (!patient) {
                return reject(new Error('Patient not found'));
            }

            // Parse existing chart data
            let surgeries = [];
            let problems = [];
            let meds = [];
            let allergies = [];
            
            try { surgeries = JSON.parse(patient.surgery_history_json) || []; } catch(e) {}
            try { problems = JSON.parse(patient.problem_list_json) || []; } catch(e) {}
            try { meds = JSON.parse(patient.medications_json) || []; } catch(e) {}
            try { allergies = JSON.parse(patient.allergies_json) || []; } catch(e) {}

            // Merge new data (avoid duplicates)
            // Handle surgeries - supports both formats:
            // 1. chartFormat: { surgeries: [{ date, procedures: [...], surgeon }] }
            // 2. legacyFormat: { surgery: { procedures: [{ procedure, date }] } }
            if (extractionData.surgeries) {
                extractionData.surgeries.forEach(surgery => {
                    const surgeryKey = `${surgery.date || 'unknown'}-${(surgery.procedures || []).join(',')}`;
                    if (!surgeries.some(s => `${s.date || 'unknown'}-${(s.procedures || []).join(',')}` === surgeryKey)) {
                        surgeries.push(surgery);
                    }
                });
            } else if (extractionData.surgery?.procedures) {
                extractionData.surgery.procedures.forEach(proc => {
                    const procName = typeof proc === 'string' ? proc : proc.procedure;
                    if (!surgeries.some(s => (s.procedures || []).includes(procName))) {
                        surgeries.push({
                            procedure: procName,
                            date: extractionData.surgery.date || null,
                            surgeon: extractionData.surgery.surgeon || null,
                            source_document_id: extractionData.source_document_id
                        });
                    }
                });
            }
            
            // Handle diagnoses - supports both formats:
            // 1. chartFormat: { diagnoses: ['dx1', 'dx2'] }
            // 2. legacyFormat: { diagnoses: { preop: [...], postop: [...] } }
            if (extractionData.diagnoses) {
                let allDiagnoses = [];
                if (Array.isArray(extractionData.diagnoses)) {
                    allDiagnoses = extractionData.diagnoses;
                } else {
                    allDiagnoses = [
                        ...(extractionData.diagnoses.preop || []),
                        ...(extractionData.diagnoses.postop || [])
                    ];
                }
                allDiagnoses.forEach(dx => {
                    const dxName = typeof dx === 'string' ? dx : dx.name || JSON.stringify(dx);
                    if (!problems.some(p => (typeof p === 'string' ? p : p.name) === dxName)) {
                        problems.push(dxName);
                    }
                });
            }
            
            if (extractionData.medications) {
                extractionData.medications.forEach(med => {
                    const medName = typeof med === 'string' ? med : med.name;
                    if (!meds.some(m => (typeof m === 'string' ? m : m.name) === medName)) {
                        meds.push(med);
                    }
                });
            }
            
            if (extractionData.allergies) {
                extractionData.allergies.forEach(allergy => {
                    const allergyName = typeof allergy === 'string' ? allergy : allergy.substance;
                    if (!allergies.some(a => (typeof a === 'string' ? a : a.substance) === allergyName)) {
                        allergies.push(allergy);
                    }
                });
            }

            // Update patient record
            const now = new Date().toISOString();
            const sql = `UPDATE patients SET 
                surgery_history_json = ?,
                problem_list_json = ?,
                medications_json = ?,
                allergies_json = ?,
                chart_summary = COALESCE(chart_summary, '') || ?,
                chart_updated_at = ?,
                updated_at = ?
                WHERE id = ?`;

            const summaryAddition = extractionData.summary ? `\n${extractionData.summary}` : '';

            db.run(sql, [
                JSON.stringify(surgeries),
                JSON.stringify(problems),
                JSON.stringify(meds),
                JSON.stringify(allergies),
                summaryAddition,
                now,
                now,
                patientId
            ], function(err) {
                if (err) return reject(err);
                resolve({
                    id: patientId,
                    surgeries,
                    problems,
                    meds,
                    allergies,
                    merged_at: now
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};

module.exports = {
    addPatient,
    getAllPatients,
    getPatientById,
    checkDuplicates,
    updatePatient,
    deletePatient,
    mergeExtractionIntoChart,
};
