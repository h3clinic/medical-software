# Patient Reports System - Implementation Guide

## What Was Built

A **patient-facing reports system** that generates visual report cards from document extractions. No LLM needed - fully deterministic.

### New Tables

1. **`patient_reports`** - Report cards shown in UI
2. **`report_artifacts`** - Generated chart images/files

### Services

**`reportGeneratorService.js`** - Signal-based report generator that creates:
- Timeline cards (key events)
- Length of stay metrics
- Procedure summaries
- Diagnosis summaries
- Medication exposure
- Functional limitations
- Follow-up reminders

### API Endpoints

```
POST /api/documents/:id/generate-reports
GET  /api/patients/:id/reports
GET  /api/patient-reports/:reportId
DELETE /api/patient-reports/:reportId
PUT  /api/patient-reports/:reportId/status
```

### UI

Simple HTML page at `/public/patient-reports.html` that displays report cards.

---

## How to Use

### 1. Run Migration

```bash
cd /Users/aharshibhattacharjee/Documents/H3Clinic/medical-database-backend
node database/migrations/002_patient_reports.js
```

### 2. Restart Server

```bash
npm start
```

### 3. Generate Reports from a Document

After uploading a document and extracting it:

```bash
curl -X POST http://localhost:3000/api/documents/1/generate-reports
```

### 4. View Reports in Browser

```
http://localhost:3000/patient-reports.html?patientId=1
```

---

## Example Report JSON Structure

```json
{
  "layout": "cards",
  "cards": [
    {
      "type": "metric",
      "title": "Length of Stay",
      "value": 4,
      "unit": "days",
      "evidence": "Date of Admission: September 17, 2025\nDate of Discharge: September 21, 2025"
    },
    {
      "type": "timeline",
      "title": "Key Events",
      "events": [
        {"date":"2025-09-17","label":"Admitted"},
        {"date":"2025-09-18","label":"Surgery"},
        {"date":"2025-09-21","label":"Discharged"}
      ]
    },
    {
      "type": "list",
      "title": "Procedures",
      "items": [
        {"label":"Total Knee Replacement","detail":"2025-09-18"}
      ]
    }
  ]
}
```

---

## Integration with Existing System

The report generator reads from `document_extractions.extracted_json` and creates patient-facing report cards. It's separate from the funding/admin reports in `/api/reports`.

### Automatic Generation (Optional)

Add to your document extraction controller after extraction completes:

```javascript
const ReportGeneratorService = require('../services/reportGeneratorService');

// After extraction saved...
const reports = ReportGeneratorService.generateReports(
    extractedJson,
    documentId,
    patientId
);

// Insert reports...
```

---

## What NOT to Do

❌ Don't mix patient reports with funding/quarterly reports
❌ Don't fake time-series data - use event/timeline cards instead
❌ Don't use this for HIPAA compliance or production without security review

---

## Files Created/Modified

**Created:**
- `/database/migrations/002_patient_reports.js`
- `/src/services/reportGeneratorService.js`
- `/src/routes/patientReportRoutes.js`
- `/public/patient-reports.html`
- `/README-REPORTS.md` (this file)

**Modified:**
- `/src/routes/index.js` - Added patient report routes
- `/src/config/database.js` - Added table creation

---

## Next Steps

1. Run migration to create tables
2. Test with existing extracted documents
3. Add "Generate Reports" button in document UI
4. Customize report card types based on your specific needs
5. Consider adding Chart.js for actual chart rendering (currently shows data only)
