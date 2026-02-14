const documentService = require('../services/documentService');
const processingPipeline = require('../services/processingPipeline');
const safeExtraction = require('../services/safeExtractionPipeline');
const patientService = require('../services/patientService');
const ReportGeneratorService = require('../services/reportGeneratorService');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Upload a document for a patient
const uploadDocument = async (req, res) => {
    try {
        const { id: patientId } = req.params;
        
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Compute SHA-256 hash for integrity verification
        const fileHash = await documentService.computeFileHash(req.file.path);
        console.log(`[Upload] File hash computed: ${fileHash.substring(0, 16)}...`);

        const document = await documentService.createDocument(
            patientId,
            req.file.originalname,
            req.file.path,
            fileHash
        );

        res.status(201).json(document);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ message: 'Error uploading document', error: error.message });
    }
};

// Get all documents for a patient
const getPatientDocuments = async (req, res) => {
    try {
        const { id: patientId } = req.params;
        const documents = await documentService.getPatientDocuments(patientId);
        res.status(200).json(documents);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving documents', error: error.message });
    }
};

// Get a specific document with extraction
const getDocument = async (req, res) => {
    try {
        const { documentId } = req.params;
        const document = await documentService.getDocumentById(documentId);
        if (!document) {
            return res.status(404).json({ message: 'Document not found' });
        }
        res.status(200).json(document);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving document', error: error.message });
    }
};

// Process a document using SAFE two-pass pipeline
const processDocument = async (req, res) => {
    const { documentId } = req.params;
    
    try {
        const document = await documentService.getDocumentById(documentId);
        if (!document) {
            return res.status(404).json({ message: 'Document not found' });
        }

        // Update status to processing
        await documentService.updateDocumentStatus(documentId, 'processing');

        // Run the SAFE processing pipeline (two-pass with invariants)
        console.log('[ProcessDocument] Starting safe extraction pipeline...');
        const result = await safeExtraction.processDocumentSafe(document);
        
        // Prepare extraction data for storage
        const extractionData = {
            schemaVersion: result.schemaVersion,
            pass1: result.pass1,
            pass2: result.pass2,
            model: result.model,
            confidence: result.confidence,
            validation: result.validation,
            reviewReasons: result.reviewReasons
        };
        
        // Prepare validation data
        const validationData = {
            invariants: result.validation,
            confidence: result.confidence,
            reviewReasons: result.reviewReasons,
            canMerge: result.canMerge,
            needsReview: result.needsReview
        };
        
        // Save extraction with validation data
        await documentService.saveExtractionWithValidation(
            documentId,
            result.model || 'unknown',
            JSON.stringify(extractionData),
            result.pass2?.summary || null,
            result.confidence.score,
            JSON.stringify(validationData)
        );

        // Update document status
        const docType = result.pass2?.doc?.doc_type || null;
        const docDate = result.pass2?.doc?.doc_date || result.pass2?.surgery?.date || null;
        await documentService.updateDocumentStatus(
            documentId, 
            result.status, 
            result.error || null, 
            result.textPath, 
            docType, 
            docDate
        );

        // CRITICAL: Only merge if canMerge is true AND not needs_review
        let mergeResult = null;
        if (result.canMerge && !result.needsReview && result.pass2) {
            console.log('[ProcessDocument] Merging into patient chart...');
            const chartData = safeExtraction.convertToChartFormat(result.pass2, documentId);
            mergeResult = await patientService.mergeExtractionIntoChart(
                document.patient_id, 
                chartData,
                { doc_type: docType, doc_date: docDate, source_document_id: documentId }
            );
            console.log('[ProcessDocument] Chart merge result:', mergeResult);
            
            // Update status to 'merged' after successful merge
            await documentService.updateDocumentStatus(documentId, 'merged');
        } else if (result.needsReview) {
            console.log('[ProcessDocument] Document needs review, NOT merging into chart');
            console.log('[ProcessDocument] Review reasons:', result.reviewReasons);
        }

        // AUTO-GENERATE PATIENT REPORTS (if extraction successful)
        let generatedReports = [];
        if (result.pass2 && result.confidence.score >= 0.6) {
            try {
                console.log('[ProcessDocument] Auto-generating patient reports...');
                const reports = ReportGeneratorService.generateReports(
                    result.pass2,
                    documentId,
                    document.patient_id
                );
                
                // Also generate the comprehensive document_render report
                // Build document object with required fields for the report generator
                const docForReport = {
                    id: documentId,
                    patient_id: document.patient_id,
                    original_filename: document.original_filename,
                    stored_path: document.stored_path,
                    text_path: result.textPath,
                    status: result.status,
                    created_at: document.created_at
                };
                const docRenderReport = ReportGeneratorService.generateDocumentRenderReport(
                    docForReport,
                    result.pass2,
                    result.validation
                );
                if (docRenderReport) {
                    reports.push(docRenderReport);
                }
                
                if (reports.length > 0) {
                    // Save reports to database
                    const db = require('../config/database');
                    const stmt = db.prepare(`
                        INSERT INTO patient_reports 
                        (patient_id, document_id, report_type, title, subtitle, report_json, confidence, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    for (const report of reports) {
                        stmt.run(
                            report.patient_id,
                            report.document_id,
                            report.report_type,
                            report.title,
                            report.subtitle,
                            report.report_json,
                            report.confidence,
                            report.status
                        );
                    }
                    stmt.finalize();
                    generatedReports = reports;
                    console.log(`[ProcessDocument] Generated ${reports.length} patient reports (incl. document_render)`);
                }
            } catch (err) {
                console.error('[ProcessDocument] Error generating reports:', err.message);
                // Don't fail the whole request if report generation fails
            }
        }

        // Return detailed response
        res.status(200).json({
            message: result.needsReview 
                ? 'Document processed but needs review before chart update' 
                : 'Document processed successfully',
            status: result.status,
            extraction: result.pass2,
            confidence: result.confidence,
            canMerge: result.canMerge,
            needsReview: result.needsReview,
            reviewReasons: result.reviewReasons,
            validation: result.validation,
            merged: mergeResult ? true : false,
            reportsGenerated: generatedReports.length,
            model: result.model
        });

    } catch (error) {
        console.error('[ProcessDocument] Error:', error);
        await documentService.updateDocumentStatus(documentId, 'error', error.message);
        res.status(500).json({ message: 'Error processing document', error: error.message });
    }
};

// Approve a needs_review document and merge into chart
const approveAndMerge = async (req, res) => {
    const { documentId } = req.params;
    
    try {
        const document = await documentService.getDocumentById(documentId);
        if (!document) {
            return res.status(404).json({ message: 'Document not found' });
        }
        
        if (document.status !== 'needs_review' && document.status !== 'extracted') {
            return res.status(400).json({ message: 'Document is not pending review' });
        }
        
        // Get the extraction
        const extraction = await documentService.getExtraction(documentId);
        if (!extraction || !extraction.extracted_json) {
            return res.status(400).json({ message: 'No extraction data found' });
        }
        
        let extractionData;
        try {
            extractionData = JSON.parse(extraction.extracted_json);
        } catch (e) {
            return res.status(400).json({ message: 'Invalid extraction data' });
        }
        
        // Merge into patient chart
        const pass2 = extractionData.pass2 || extractionData;
        const chartData = safeExtraction.convertToChartFormat(pass2, documentId);
        const mergeResult = await patientService.mergeExtractionIntoChart(
            document.patient_id, 
            chartData,
            { 
                doc_type: pass2?.doc?.doc_type, 
                doc_date: pass2?.doc?.doc_date || pass2?.surgery?.date,
                source_document_id: documentId,
                manually_approved: true
            }
        );
        
        // Update status to merged
        await documentService.updateDocumentStatus(documentId, 'merged');
        
        res.status(200).json({
            message: 'Document approved and merged into chart',
            merged: true,
            mergeResult
        });
        
    } catch (error) {
        console.error('[ApproveAndMerge] Error:', error);
        res.status(500).json({ message: 'Error approving document', error: error.message });
    }
};

// Get extraction for a document
const getExtraction = async (req, res) => {
    try {
        const { documentId } = req.params;
        const extraction = await documentService.getExtraction(documentId);
        if (!extraction) {
            return res.status(404).json({ message: 'No extraction found' });
        }
        res.status(200).json(extraction);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving extraction', error: error.message });
    }
};

// Delete a document
const deleteDocument = async (req, res) => {
    try {
        const { documentId } = req.params;
        const document = await documentService.getDocumentById(documentId);
        
        if (document && document.stored_path && fs.existsSync(document.stored_path)) {
            fs.unlinkSync(document.stored_path);
        }
        if (document && document.text_path && fs.existsSync(document.text_path)) {
            fs.unlinkSync(document.text_path);
        }
        
        await documentService.deleteDocument(documentId);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: 'Error deleting document', error: error.message });
    }
};

// Check LLM (Ollama) health status
const checkLLMHealth = async (req, res) => {
    const { isOllamaAvailable } = require('../services/processingPipeline');
    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    
    try {
        const available = await isOllamaAvailable();
        
        if (available) {
            // Try to get model list
            const response = await fetch(`${OLLAMA_URL}/api/tags`);
            const data = await response.json();
            const models = data.models?.map(m => m.name) || [];
            
            res.status(200).json({
                status: 'online',
                url: OLLAMA_URL,
                models: models,
                hasRecommendedModel: models.some(m => m.includes('qwen2.5') || m.includes('llama')),
                message: 'Ollama is running'
            });
        } else {
            res.status(200).json({
                status: 'offline',
                url: OLLAMA_URL,
                models: [],
                hasRecommendedModel: false,
                message: 'Ollama not running. Using regex fallback for extraction.',
                instructions: 'Run: brew install ollama && ollama serve'
            });
        }
    } catch (error) {
        res.status(200).json({
            status: 'error',
            url: OLLAMA_URL,
            models: [],
            hasRecommendedModel: false,
            message: error.message,
            instructions: 'Run: brew install ollama && ollama serve'
        });
    }
};

// ========== v2: Selective merge endpoint ==========
const selectiveMerge = async (req, res) => {
    const { documentId } = req.params;
    const { merge } = req.body;
    
    try {
        const document = await documentService.getDocumentById(documentId);
        if (!document) {
            return res.status(404).json({ message: 'Document not found' });
        }
        
        // Get the extraction
        const extraction = await documentService.getExtraction(documentId);
        if (!extraction || !extraction.extracted_json) {
            return res.status(400).json({ message: 'No extraction data found' });
        }
        
        let extractionData;
        try {
            extractionData = JSON.parse(extraction.extracted_json);
        } catch (e) {
            return res.status(400).json({ message: 'Invalid extraction data' });
        }
        
        // Validate merge config
        const mergeConfig = {
            procedures: merge?.procedures !== false,
            diagnoses: merge?.diagnoses !== false,
            medications: merge?.medications !== false,
            allergies: merge?.allergies !== false
        };
        
        // Convert to chart format
        const pass2 = extractionData.pass2 || extractionData;
        const chartData = safeExtraction.convertToChartFormat(pass2, documentId);
        
        // Run selective merge
        const mergeResult = await patientService.selectiveMergeIntoChart(
            document.patient_id,
            chartData,
            mergeConfig,
            { 
                doc_type: pass2?.doc?.doc_type, 
                doc_date: pass2?.doc?.doc_date || pass2?.surgery?.date,
                source_document_id: documentId
            }
        );
        
        // Update status to merged
        await documentService.updateDocumentStatus(documentId, 'merged');
        
        res.status(200).json({
            message: 'Selective merge completed',
            merged: true,
            merge_config: mergeConfig,
            merge_summary: mergeResult.merge_summary
        });
        
    } catch (error) {
        console.error('[SelectiveMerge] Error:', error);
        res.status(500).json({ message: 'Error performing selective merge', error: error.message });
    }
};

// ========== v2: Get conflicts for a document ==========
const getConflicts = async (req, res) => {
    const { documentId } = req.params;
    
    try {
        const document = await documentService.getDocumentById(documentId);
        if (!document) {
            return res.status(404).json({ message: 'Document not found' });
        }
        
        // Get extraction
        const extraction = await documentService.getExtraction(documentId);
        if (!extraction || !extraction.extracted_json) {
            return res.status(200).json({ hasConflicts: false, conflicts: [], message: 'No extraction to compare' });
        }
        
        let extractionData;
        try {
            extractionData = JSON.parse(extraction.extracted_json);
        } catch (e) {
            return res.status(400).json({ message: 'Invalid extraction data' });
        }
        
        // Get current patient chart
        const patient = await patientService.getPatientWithChart(document.patient_id);
        if (!patient) {
            return res.status(404).json({ message: 'Patient not found' });
        }
        
        // Convert extraction to chart format for comparison
        const pass2 = extractionData.pass2 || extractionData;
        const chartData = safeExtraction.convertToChartFormat(pass2, documentId);
        
        // Run conflict detection
        const conflictResult = safeExtraction.detectConflicts(chartData, patient);
        
        res.status(200).json({
            document_id: parseInt(documentId),
            patient_id: document.patient_id,
            ...conflictResult
        });
        
    } catch (error) {
        console.error('[GetConflicts] Error:', error);
        res.status(500).json({ message: 'Error detecting conflicts', error: error.message });
    }
};

// ========== v2: Get all reports for a specific document ==========
const getDocumentReports = async (req, res) => {
    const { documentId } = req.params;
    const db = require('../config/database');
    
    try {
        db.all(
            `SELECT * FROM patient_reports WHERE document_id = ? ORDER BY created_at DESC`,
            [documentId],
            (err, rows) => {
                if (err) {
                    return res.status(500).json({ message: 'Error retrieving reports', error: err.message });
                }
                res.status(200).json(rows || []);
            }
        );
    } catch (error) {
        console.error('[GetDocumentReports] Error:', error);
        res.status(500).json({ message: 'Error retrieving reports', error: error.message });
    }
};

module.exports = {
    uploadDocument,
    getPatientDocuments,
    getDocument,
    processDocument,
    approveAndMerge,
    selectiveMerge,
    getConflicts,
    getDocumentReports,
    getExtraction,
    deleteDocument,
    checkLLMHealth
};
