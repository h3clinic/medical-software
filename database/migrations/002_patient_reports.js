const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database/medical.db');

db.serialize(() => {
    // Patient Reports table - represents report cards in the UI
    db.run(`CREATE TABLE IF NOT EXISTS patient_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL,
        document_id INTEGER,
        report_type TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        report_json TEXT NOT NULL,
        confidence REAL DEFAULT 0.8,
        status TEXT DEFAULT 'generated',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(id),
        FOREIGN KEY (document_id) REFERENCES patient_documents(id)
    )`, (err) => {
        if (err) console.error('Error creating patient_reports table: ' + err.message);
        else console.log('Patient reports table created');
    });

    // Report Artifacts table - stores generated chart images/files
    db.run(`CREATE TABLE IF NOT EXISTS report_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        artifact_type TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (report_id) REFERENCES patient_reports(id)
    )`, (err) => {
        if (err) console.error('Error creating report_artifacts table: ' + err.message);
        else console.log('Report artifacts table created');
    });

    // Create index for faster patient report lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_patient_reports_patient_id 
            ON patient_reports(patient_id)`, (err) => {
        if (err) console.error('Error creating patient_reports index: ' + err.message);
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_patient_reports_document_id 
            ON patient_reports(document_id)`, (err) => {
        if (err) console.error('Error creating document_id index: ' + err.message);
    });
});

db.close();
