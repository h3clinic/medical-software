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
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (intake_batch_id) REFERENCES intake_batches(id)
            )`, (err) => {
                if (err) console.error('Error creating patients table: ' + err.message);
                else console.log('Patients table ready');
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
        });
    }
});

module.exports = db;
