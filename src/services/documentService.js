const db = require('../config/database');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Compute SHA-256 hash of a file (for integrity verification)
const computeFileHash = (filePath) => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
};

// Get all documents for a patient
const getPatientDocuments = (patientId) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT pd.*, de.extracted_json, de.summary, de.confidence, de.model
                     FROM patient_documents pd
                     LEFT JOIN document_extractions de ON pd.id = de.document_id
                     WHERE pd.patient_id = ?
                     ORDER BY pd.created_at DESC`;
        db.all(sql, [patientId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

// Create a document record with hash for integrity
const createDocument = (patientId, originalFilename, storedPath, fileHash = null) => {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO patient_documents (patient_id, original_filename, stored_path, file_hash, status)
                     VALUES (?, ?, ?, ?, 'uploaded')`;
        db.run(sql, [patientId, originalFilename, storedPath, fileHash], function(err) {
            if (err) return reject(err);
            resolve({ 
                id: this.lastID, 
                patient_id: patientId, 
                original_filename: originalFilename, 
                stored_path: storedPath, 
                file_hash: fileHash,
                status: 'uploaded' 
            });
        });
    });
};

// Get document by ID
const getDocumentById = (documentId) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT pd.*, de.id as extraction_id, de.extracted_json, de.summary, de.confidence, de.model
                     FROM patient_documents pd
                     LEFT JOIN document_extractions de ON pd.id = de.document_id
                     WHERE pd.id = ?`;
        db.get(sql, [documentId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

// Update document status
const updateDocumentStatus = (documentId, status, errorMessage = null, textPath = null) => {
    return new Promise((resolve, reject) => {
        let sql = `UPDATE patient_documents SET status = ?`;
        const params = [status];
        
        if (errorMessage !== null) {
            sql += `, error_message = ?`;
            params.push(errorMessage);
        }
        if (textPath !== null) {
            sql += `, text_path = ?`;
            params.push(textPath);
        }
        sql += ` WHERE id = ?`;
        params.push(documentId);
        
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve({ documentId, status });
        });
    });
};

// Save extraction result
const saveExtraction = (documentId, model, extractedJson, summary, confidence) => {
    return new Promise((resolve, reject) => {
        // First delete any existing extraction for this document
        db.run(`DELETE FROM document_extractions WHERE document_id = ?`, [documentId], (err) => {
            if (err) return reject(err);
            
            const sql = `INSERT INTO document_extractions (document_id, model, extracted_json, summary, confidence)
                         VALUES (?, ?, ?, ?, ?)`;
            db.run(sql, [documentId, model, extractedJson, summary, confidence], function(err) {
                if (err) return reject(err);
                resolve({ id: this.lastID, documentId, model, confidence });
            });
        });
    });
};

// Save extraction with validation data (for safe pipeline)
const saveExtractionWithValidation = (documentId, model, extractedJson, summary, confidence, validationJson) => {
    return new Promise((resolve, reject) => {
        // First delete any existing extraction for this document
        db.run(`DELETE FROM document_extractions WHERE document_id = ?`, [documentId], (err) => {
            if (err) return reject(err);
            
            const sql = `INSERT INTO document_extractions (document_id, model, extracted_json, summary, confidence, validation_json)
                         VALUES (?, ?, ?, ?, ?, ?)`;
            db.run(sql, [documentId, model, extractedJson, summary, confidence, validationJson], function(err) {
                if (err) return reject(err);
                resolve({ id: this.lastID, documentId, model, confidence });
            });
        });
    });
};

// Get extraction for a document
const getExtraction = (documentId) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM document_extractions WHERE document_id = ? ORDER BY created_at DESC LIMIT 1`;
        db.get(sql, [documentId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

// Delete document and its extraction
const deleteDocument = (documentId) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`DELETE FROM document_extractions WHERE document_id = ?`, [documentId]);
            db.run(`DELETE FROM patient_documents WHERE id = ?`, [documentId], function(err) {
                if (err) return reject(err);
                resolve({ deletedId: documentId });
            });
        });
    });
};

// Verify document integrity by checking hash
const verifyDocumentIntegrity = async (documentId) => {
    const doc = await getDocumentById(documentId);
    if (!doc) throw new Error('Document not found');
    if (!doc.file_hash) return { verified: false, reason: 'No hash stored' };
    
    const currentHash = await computeFileHash(doc.stored_path);
    const matches = currentHash === doc.file_hash;
    
    return {
        verified: matches,
        storedHash: doc.file_hash,
        currentHash,
        reason: matches ? 'File integrity verified' : 'FILE MODIFIED - hash mismatch!'
    };
};

module.exports = {
    getPatientDocuments,
    createDocument,
    getDocumentById,
    updateDocumentStatus,
    saveExtraction,
    saveExtractionWithValidation,
    getExtraction,
    deleteDocument,
    computeFileHash,
    verifyDocumentIntegrity
};
