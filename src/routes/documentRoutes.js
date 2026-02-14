const express = require('express');
const multer = require('multer');
const path = require('path');
const documentController = require('../controllers/documentController');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadsDir = path.resolve(__dirname, '../../uploads');
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF and image files are allowed'), false);
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Routes for patient documents
router.post('/patients/:id/documents', upload.single('file'), documentController.uploadDocument);
router.get('/patients/:id/documents', documentController.getPatientDocuments);

// Routes for document processing
router.post('/documents/:documentId/process', documentController.processDocument);
router.post('/documents/:documentId/approve', documentController.approveAndMerge);
router.post('/documents/:documentId/merge', documentController.selectiveMerge);
router.get('/documents/:documentId', documentController.getDocument);
router.get('/documents/:documentId/extraction', documentController.getExtraction);
router.get('/documents/:documentId/conflicts', documentController.getConflicts);
router.get('/documents/:documentId/reports', documentController.getDocumentReports);
router.delete('/documents/:documentId', documentController.deleteDocument);

// Ollama health check endpoint
router.get('/llm/health', documentController.checkLLMHealth);

module.exports = router;
