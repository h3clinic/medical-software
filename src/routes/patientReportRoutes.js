const express = require('express');
const router = express.Router();
const db = require('../config/database');
const ReportGeneratorService = require('../services/reportGeneratorService');

/**
 * Generate document_render report for a document
 * POST /api/documents/:id/generate-document-report
 * Creates a comprehensive report showing the document like PDF + extracted sections + graphs
 */
router.post('/documents/:id/generate-document-report', (req, res) => {
    const documentId = parseInt(req.params.id);

    // Get document with extraction and validation data
    db.get(
        `SELECT pd.*, de.extracted_json, de.validation_json, de.confidence
         FROM patient_documents pd
         LEFT JOIN document_extractions de ON de.document_id = pd.id
         WHERE pd.id = ?
         ORDER BY de.created_at DESC
         LIMIT 1`,
        [documentId],
        (err, doc) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!doc) {
                return res.status(404).json({ error: 'Document not found' });
            }
            if (!doc.extracted_json) {
                return res.status(400).json({ error: 'No extraction found for this document. Process the document first.' });
            }

            try {
                // Parse extraction and unwrap pass2 if present
                let extractionData = typeof doc.extracted_json === 'string' 
                    ? JSON.parse(doc.extracted_json) 
                    : doc.extracted_json;
                
                if (extractionData.pass2) {
                    extractionData = extractionData.pass2;
                }
                
                // Generate the document_render report
                const report = ReportGeneratorService.generateDocumentRenderReport(
                    doc,
                    extractionData,
                    doc.validation_json
                );

                // Upsert: update if exists, insert if not
                db.get(
                    'SELECT id FROM patient_reports WHERE document_id = ? AND report_type = ?',
                    [documentId, 'document_render'],
                    (err, existing) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }

                        if (existing) {
                            // Update existing report
                            db.run(
                                `UPDATE patient_reports 
                                 SET title = ?, subtitle = ?, report_json = ?, confidence = ?, status = ?
                                 WHERE id = ?`,
                                [report.title, report.subtitle, report.report_json, report.confidence, report.status, existing.id],
                                function(err) {
                                    if (err) {
                                        return res.status(500).json({ error: err.message });
                                    }
                                    res.json({
                                        message: 'Document report updated',
                                        id: existing.id,
                                        report: { id: existing.id, ...report }
                                    });
                                }
                            );
                        } else {
                            // Insert new report
                            db.run(
                                `INSERT INTO patient_reports 
                                 (patient_id, document_id, report_type, title, subtitle, report_json, confidence, status)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                [report.patient_id, report.document_id, report.report_type, report.title, report.subtitle, report.report_json, report.confidence, report.status],
                                function(err) {
                                    if (err) {
                                        return res.status(500).json({ error: err.message });
                                    }
                                    res.status(201).json({
                                        message: 'Document report generated',
                                        id: this.lastID,
                                        report: { id: this.lastID, ...report }
                                    });
                                }
                            );
                        }
                    }
                );
            } catch (err) {
                res.status(500).json({ error: 'Error generating document report: ' + err.message });
            }
        }
    );
});

/**
 * Generate reports from a document's extraction
 * POST /api/documents/:id/generate-reports
 * 
 * IDEMPOTENT: Uses upsert by (patient_id, document_id, report_type)
 * Returns created_count, updated_count, skipped_count, report_ids
 */
router.post('/documents/:id/generate-reports', (req, res) => {
    const documentId = parseInt(req.params.id);

    // Get document and latest extraction
    db.get(
        `SELECT pd.*, de.extracted_json, de.confidence, de.validation_json, pd.patient_id
         FROM patient_documents pd
         LEFT JOIN document_extractions de ON de.document_id = pd.id
         WHERE pd.id = ?
         ORDER BY de.created_at DESC
         LIMIT 1`,
        [documentId],
        (err, doc) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!doc) {
                return res.status(404).json({ error: 'Document not found' });
            }
            if (!doc.extracted_json) {
                return res.status(400).json({ error: 'No extraction found for this document' });
            }

            try {
                // Parse the extraction - it may have pass2 wrapped inside
                let extractionData = typeof doc.extracted_json === 'string' 
                    ? JSON.parse(doc.extracted_json) 
                    : doc.extracted_json;
                
                // Unwrap pass2 if it exists (new schema format)
                if (extractionData.pass2) {
                    extractionData = extractionData.pass2;
                }
                
                // Generate reports
                const reports = ReportGeneratorService.generateReports(
                    extractionData,
                    documentId,
                    doc.patient_id,
                    doc.validation_json
                );
                
                // Also generate document_render report
                const docRenderReport = ReportGeneratorService.generateDocumentRenderReport(
                    doc,
                    extractionData,
                    doc.validation_json
                );
                if (docRenderReport) {
                    reports.push(docRenderReport);
                }
                
                // v2: Also generate document_digest (one-page summary)
                const docDigestReport = ReportGeneratorService.generateDocumentDigest(
                    doc,
                    extractionData,
                    doc.validation_json
                );
                if (docDigestReport) {
                    reports.push(docDigestReport);
                }

                if (reports.length === 0) {
                    return res.json({
                        message: 'No reportable content found in extraction',
                        created_count: 0,
                        updated_count: 0,
                        skipped_count: 0,
                        report_ids: []
                    });
                }

                // IDEMPOTENT UPSERT: Check existing reports by (patient_id, document_id, report_type)
                const patientId = doc.patient_id;
                db.all(
                    'SELECT id, report_type FROM patient_reports WHERE patient_id = ? AND document_id = ?',
                    [patientId, documentId],
                    (err, existingReports) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }

                        const existingByType = {};
                        existingReports.forEach(r => { existingByType[r.report_type] = r.id; });

                        let created_count = 0;
                        let updated_count = 0;
                        let skipped_count = 0;
                        const report_ids = [];
                        let completed = 0;

                        const processReport = (report, callback) => {
                            const existingId = existingByType[report.report_type];
                            
                            if (existingId) {
                                // UPDATE existing report
                                db.run(
                                    `UPDATE patient_reports 
                                     SET title = ?, subtitle = ?, report_json = ?, confidence = ?, status = ?, created_at = CURRENT_TIMESTAMP
                                     WHERE id = ?`,
                                    [report.title, report.subtitle, report.report_json, report.confidence, report.status, existingId],
                                    function(err) {
                                        if (err) {
                                            console.error('Error updating report:', err.message);
                                            skipped_count++;
                                        } else {
                                            updated_count++;
                                            report_ids.push(existingId);
                                        }
                                        callback();
                                    }
                                );
                            } else {
                                // INSERT new report
                                db.run(
                                    `INSERT INTO patient_reports 
                                     (patient_id, document_id, report_type, title, subtitle, report_json, confidence, status)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [report.patient_id, report.document_id, report.report_type, report.title, report.subtitle, report.report_json, report.confidence, report.status],
                                    function(err) {
                                        if (err) {
                                            console.error('Error inserting report:', err.message);
                                            skipped_count++;
                                        } else {
                                            created_count++;
                                            report_ids.push(this.lastID);
                                        }
                                        callback();
                                    }
                                );
                            }
                        };

                        // Process reports sequentially
                        const processNext = (index) => {
                            if (index >= reports.length) {
                                return res.json({
                                    message: `Processed ${reports.length} reports`,
                                    created_count,
                                    updated_count,
                                    skipped_count,
                                    report_ids
                                });
                            }
                            processReport(reports[index], () => processNext(index + 1));
                        };

                        processNext(0);
                    }
                );
            } catch (err) {
                res.status(500).json({ error: 'Error generating reports: ' + err.message });
            }
        }
    );
});

/**
 * List all reports for a patient
 * GET /api/patients/:id/reports
 */
router.get('/patients/:id/reports', (req, res) => {
    const patientId = parseInt(req.params.id);

    db.all(
        `SELECT pr.*, pd.original_filename
         FROM patient_reports pr
         LEFT JOIN patient_documents pd ON pd.id = pr.document_id
         WHERE pr.patient_id = ?
         ORDER BY pr.created_at DESC`,
        [patientId],
        (err, reports) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(reports);
        }
    );
});

/**
 * Get single report with full JSON
 * GET /api/patient-reports/:reportId
 */
router.get('/patient-reports/:reportId', (req, res) => {
    const reportId = parseInt(req.params.reportId);

    db.get(
        'SELECT * FROM patient_reports WHERE id = ?',
        [reportId],
        (err, report) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!report) {
                return res.status(404).json({ error: 'Report not found' });
            }

            // Parse report_json for easier consumption
            try {
                report.report_json = JSON.parse(report.report_json);
            } catch (e) {
                console.error('Error parsing report JSON:', e);
            }

            res.json(report);
        }
    );
});

/**
 * Delete a report
 * DELETE /api/patient-reports/:reportId
 */
router.delete('/patient-reports/:reportId', (req, res) => {
    const reportId = parseInt(req.params.reportId);

    db.run('DELETE FROM patient_reports WHERE id = ?', [reportId], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Report not found' });
        }
        res.json({ message: 'Report deleted' });
    });
});

/**
 * Update report status
 * PUT /api/patient-reports/:reportId/status
 */
router.put('/patient-reports/:reportId/status', (req, res) => {
    const reportId = parseInt(req.params.reportId);
    const { status } = req.body;

    const validStatuses = ['generated', 'needs_review', 'error', 'reviewed'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    db.run(
        'UPDATE patient_reports SET status = ? WHERE id = ?',
        [status, reportId],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Report not found' });
            }
            res.json({ message: 'Status updated', status });
        }
    );
});

/**
 * Mark report as reviewed
 * POST /api/patient-reports/:reportId/mark-reviewed
 */
router.post('/patient-reports/:reportId/mark-reviewed', (req, res) => {
    const reportId = parseInt(req.params.reportId);
    const { reviewer_notes } = req.body;

    db.run(
        'UPDATE patient_reports SET status = ? WHERE id = ?',
        ['reviewed', reportId],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Report not found' });
            }
            res.json({ 
                message: 'Report marked as reviewed', 
                status: 'reviewed',
                reviewer_notes: reviewer_notes || null
            });
        }
    );
});

/**
 * Edit report JSON (for corrections)
 * POST /api/patient-reports/:reportId/edit
 */
router.post('/patient-reports/:reportId/edit', (req, res) => {
    const reportId = parseInt(req.params.reportId);
    const { report_json, title, subtitle } = req.body;

    if (!report_json) {
        return res.status(400).json({ error: 'report_json is required' });
    }

    // Validate JSON
    try {
        const parsed = typeof report_json === 'string' ? JSON.parse(report_json) : report_json;
        const jsonStr = JSON.stringify(parsed);

        const updates = ['report_json = ?', 'status = ?'];
        const params = [jsonStr, 'reviewed'];

        if (title) {
            updates.push('title = ?');
            params.push(title);
        }
        if (subtitle) {
            updates.push('subtitle = ?');
            params.push(subtitle);
        }

        params.push(reportId);

        db.run(
            `UPDATE patient_reports SET ${updates.join(', ')} WHERE id = ?`,
            params,
            function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Report not found' });
                }
                res.json({ 
                    message: 'Report updated successfully',
                    id: reportId,
                    status: 'reviewed'
                });
            }
        );
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
    }
});

/**
 * Get document with PDF URL for viewing
 * GET /api/documents/:id/view
 */
router.get('/documents/:id/view', (req, res) => {
    const documentId = parseInt(req.params.id);

    db.get(
        `SELECT pd.*, de.extracted_json, de.validation_json, de.confidence, de.summary,
                pr.id as report_id, pr.report_json as document_report_json, pr.status as report_status
         FROM patient_documents pd
         LEFT JOIN document_extractions de ON de.document_id = pd.id
         LEFT JOIN patient_reports pr ON pr.document_id = pd.id AND pr.report_type = 'document_render'
         WHERE pd.id = ?
         ORDER BY de.created_at DESC
         LIMIT 1`,
        [documentId],
        (err, doc) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!doc) {
                return res.status(404).json({ error: 'Document not found' });
            }

            // Build response with URLs
            const response = {
                id: doc.id,
                patient_id: doc.patient_id,
                original_filename: doc.original_filename,
                status: doc.status,
                created_at: doc.created_at,
                pdf_url: doc.stored_path ? `/uploads/${doc.stored_path.split('/').pop()}` : null,
                text_url: doc.text_path ? `/uploads/${doc.text_path.split('/').pop()}` : null,
                has_extraction: !!doc.extracted_json,
                extraction_confidence: doc.confidence,
                summary: doc.summary,
                has_document_report: !!doc.document_report_json,
                report_id: doc.report_id,
                report_status: doc.report_status
            };

            // Parse extraction if exists
            if (doc.extracted_json) {
                try {
                    response.extraction = JSON.parse(doc.extracted_json);
                } catch (e) {
                    response.extraction = null;
                }
            }

            // Parse document report if exists
            if (doc.document_report_json) {
                try {
                    response.document_report = JSON.parse(doc.document_report_json);
                } catch (e) {
                    response.document_report = null;
                }
            }

            res.json(response);
        }
    );
});

module.exports = router;
