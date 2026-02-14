# 🚀 Patient Reports Quick Start Guide

## 3-Minute Setup

### Step 1: Run Migration (30 seconds)
```bash
cd /Users/aharshibhattacharjee/Documents/H3Clinic/medical-database-backend
node database/migrations/002_patient_reports.js
```

**Expected output:**
```
Patient reports table created
Report artifacts table created
```

### Step 2: Start Server (10 seconds)
```bash
npm start
```

**Expected output:**
```
Server running on port 3000
Connected to the SQLite database.
```

### Step 3: Test Report Generation (30 seconds)
```bash
# In a new terminal
cd /Users/aharshibhattacharjee/Documents/H3Clinic/medical-database-backend
node tests/test-reports.js
```

**Expected output:**
```
✅ Generated 7 reports:
1. Key Events Timeline
2. Length of Stay
3. Procedures
...
```

### Step 4: View Reports in Browser (10 seconds)
```
http://localhost:3000/patient-reports.html?patientId=1
```

---

## 📝 Usage Examples

### Example 1: Generate Reports for Existing Document

```bash
# Get document ID from your database
sqlite3 database/medical.db "SELECT id, original_filename FROM patient_documents LIMIT 5"

# Generate reports
curl -X POST http://localhost:3000/api/documents/1/generate-reports
```

### Example 2: View All Reports for a Patient

```bash
curl http://localhost:3000/api/patients/1/reports | json_pp
```

### Example 3: Complete Flow (Upload → Process → View)

```bash
# 1. Upload document
curl -X POST http://localhost:3000/api/patients/1/documents \
  -F "file=@/path/to/medical-report.pdf"

# Response includes documentId: 123

# 2. Process document (auto-generates reports if confidence ≥ 0.6)
curl -X POST http://localhost:3000/api/documents/123/process

# 3. View reports
open http://localhost:3000/patient-reports.html?patientId=1
```

---

## 🎯 What Reports Get Generated?

Based on document content, you'll automatically get:

| If Document Contains... | Report Generated |
|------------------------|------------------|
| Admission + discharge dates | ✅ Length of Stay metric |
| 2+ dates | ✅ Timeline card |
| Procedure mentions | ✅ Procedure summary |
| Diagnoses | ✅ Diagnosis summary |
| Medications | ✅ Medication exposure |
| Functional limitations | ✅ Restrictions card |
| "Follow-up" or "10-14 days" | ✅ Follow-up reminder |

**Zero documents → Zero reports (no fake data)**

---

## 🔍 Troubleshooting

### Reports Not Generating?

```bash
# Check if extraction exists
sqlite3 database/medical.db "SELECT id, document_id, confidence FROM document_extractions WHERE document_id=1"

# Check extraction confidence (must be ≥ 0.6)
# If < 0.6, reports won't auto-generate
```

### Can't See Reports in UI?

```bash
# Check if reports were created
sqlite3 database/medical.db "SELECT * FROM patient_reports WHERE patient_id=1"

# If empty, manually trigger generation:
curl -X POST http://localhost:3000/api/documents/1/generate-reports
```

### Server Won't Start?

```bash
# Check for port conflicts
lsof -ti:3000
# If running, kill it: kill -9 <PID>

# Check for missing modules
npm install

# Check database exists
ls -lh database/medical.db
```

---

## 📊 Sample Report Output

```json
{
  "id": 1,
  "patient_id": 1,
  "document_id": 1,
  "report_type": "postop_summary",
  "title": "Length of Stay",
  "subtitle": "4 days",
  "report_json": {
    "layout": "cards",
    "cards": [{
      "type": "metric",
      "title": "Length of Stay",
      "value": 4,
      "unit": "days",
      "evidence": "Date of Admission: September 17, 2025\nDate of Discharge: September 21, 2025"
    }]
  },
  "confidence": 0.95,
  "status": "generated",
  "created_at": "2026-01-06T12:00:00.000Z"
}
```

---

## ✅ Verification Checklist

After setup, verify:

- [ ] Tables created: `sqlite3 database/medical.db ".tables"` shows `patient_reports`
- [ ] Test passes: `node tests/test-reports.js` shows 7 reports
- [ ] Server starts: `npm start` runs without errors
- [ ] UI loads: Browser shows patient-reports.html
- [ ] API works: `curl http://localhost:3000/api/patients/1/reports` returns JSON

---

## 📞 Quick Commands Reference

```bash
# Database
sqlite3 database/medical.db "SELECT COUNT(*) FROM patient_reports"
sqlite3 database/medical.db "DELETE FROM patient_reports WHERE id=1"

# API
curl http://localhost:3000/api/patients/1/reports
curl -X POST http://localhost:3000/api/documents/1/generate-reports
curl -X DELETE http://localhost:3000/api/patient-reports/1

# Testing
node tests/test-reports.js
npm test

# Server
npm start
npm run dev  # if you have nodemon
```

---

**Setup Time:** ~3 minutes  
**Dependencies:** SQLite, Node.js, Express (already installed)  
**Breaking Changes:** None (backward compatible)
