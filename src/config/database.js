const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../../database/medical.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database ' + err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            // Intake Batches table
            db.run(`CREATE TABLE IF NOT EXISTS intake_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Error creating intake_batches table: ' + err.message);
                else console.log('Intake batches table ready');
            });

            // Patients table (with intake fields)
            db.run(`CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                date_of_birth TEXT,
                age INTEGER,
                gender TEXT,
                contact TEXT,
                email TEXT,
                address TEXT,
                source_file_id TEXT,
                intake_batch_id INTEGER,
                scanned_by TEXT,
                intake_notes TEXT,
                has_unknown_fields INTEGER DEFAULT 0,
                intake_checklist TEXT,
                surgery_history_json TEXT,
                problem_list_json TEXT,
                medications_json TEXT,
                allergies_json TEXT,
                chart_summary TEXT,
                chart_updated_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (intake_batch_id) REFERENCES intake_batches(id)
            )`, (err) => {
                if (err) console.error('Error creating patients table: ' + err.message);
                else console.log('Patients table ready');
            });

            // Add chart columns to existing patients table (migration)
            const chartColumns = [
                'surgery_history_json TEXT',
                'problem_list_json TEXT', 
                'medications_json TEXT',
                'allergies_json TEXT',
                'chart_summary TEXT',
                'chart_updated_at TEXT'
            ];
            chartColumns.forEach(col => {
                const colName = col.split(' ')[0];
                db.run(`ALTER TABLE patients ADD COLUMN ${col}`, (err) => {
                    // Ignore "duplicate column" errors - expected if column exists
                });
            });

            // Visits table
            db.run(`CREATE TABLE IF NOT EXISTS visits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                visit_date TEXT NOT NULL,
                chief_complaint TEXT,
                vitals_json TEXT,
                assessment TEXT,
                diagnosis TEXT,
                plan TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (patient_id) REFERENCES patients(id)
            )`, (err) => {
                if (err) console.error('Error creating visits table: ' + err.message);
                else console.log('Visits table ready');
            });

            // Journal entries table (update log for each patient)
            db.run(`CREATE TABLE IF NOT EXISTS journal_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                entry_date TEXT DEFAULT CURRENT_TIMESTAMP,
                entry_type TEXT DEFAULT 'note',
                title TEXT,
                content TEXT NOT NULL,
                created_by TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (patient_id) REFERENCES patients(id)
            )`, (err) => {
                if (err) console.error('Error creating journal_entries table: ' + err.message);
                else console.log('Journal entries table ready');
            });

            // Patient documents table
            db.run(`CREATE TABLE IF NOT EXISTS patient_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                original_filename TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                file_hash TEXT,
                text_path TEXT,
                status TEXT DEFAULT 'uploaded',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (patient_id) REFERENCES patients(id)
            )`, (err) => {
                if (err) console.error('Error creating patient_documents table: ' + err.message);
                else console.log('Patient documents table ready');
            });

            // Document extractions table (AI extracted data)
            db.run(`CREATE TABLE IF NOT EXISTS document_extractions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                extracted_json TEXT,
                summary TEXT,
                confidence REAL,
                model TEXT,
                needs_review INTEGER DEFAULT 0,
                reviewed_at TEXT,
                merged_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (document_id) REFERENCES patient_documents(id)
            )`, (err) => {
                if (err) console.error('Error creating document_extractions table: ' + err.message);
                else console.log('Document extractions table ready');
            });
        });
    }
});

module.exports = db;
