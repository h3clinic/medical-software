/**
 * Funding Report Service
 * 
 * Generates quarterly funding reports for government/agency submission.
 * Reports are de-identified and include impact metrics, efficiency data,
 * and data quality indicators.
 */

const db = require('../config/database');

// Configuration for funding reports
const FUNDING_REPORT_CONFIG = {
    minutesSavedPerDoc: 8,        // Conservative estimate of staff time saved per document
    staffHourlyRateUSD: 28,       // Conservative administrative staff hourly rate
    opioidList: ['morphine', 'hydromorphone', 'oxycodone', 'hydrocodone', 'fentanyl', 'tramadol', 'codeine'],
    cellSuppressionMin: 11,       // Minimum count before displaying (privacy protection)
    organizationName: 'H3Clinic',
    programName: 'Medical Document Processing & Care Coordination'
};

/**
 * Parse JSON safely with fallback
 */
function safeParseJSON(str, defaultVal = []) {
    if (!str) return defaultVal;
    try {
        return JSON.parse(str);
    } catch (e) {
        return defaultVal;
    }
}

/**
 * Calculate quarter date range
 */
function getQuarterDates(year, quarter) {
    const quarters = {
        1: { start: `${year}-01-01`, end: `${year}-03-31` },
        2: { start: `${year}-04-01`, end: `${year}-06-30` },
        3: { start: `${year}-07-01`, end: `${year}-09-30` },
        4: { start: `${year}-10-01`, end: `${year}-12-31` }
    };
    
    if (!quarters[quarter]) {
        throw new Error('Quarter must be 1-4');
    }
    
    return quarters[quarter];
}

/**
 * Apply cell suppression (privacy protection)
 */
function applyCellSuppression(count, min = FUNDING_REPORT_CONFIG.cellSuppressionMin) {
    if (count === 0) return 0;
    if (count < min) return `<${min}`;
    return count;
}

/**
 * Check if a date string falls within a range
 */
function isDateInRange(dateStr, startDate, endDate) {
    if (!dateStr) return false;
    
    // Parse various date formats
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return false;
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    return date >= start && date <= end;
}

/**
 * Generate quarterly funding report
 */
async function generateQuarterlyReport(year, quarter, startDate = null, endDate = null) {
    // Determine date range
    const dateRange = startDate && endDate 
        ? { start: startDate, end: endDate }
        : getQuarterDates(year, quarter);
    
    console.log(`[FundingReport] Generating report for ${dateRange.start} to ${dateRange.end}`);
    
    const report = {
        metadata: {
            organizationName: FUNDING_REPORT_CONFIG.organizationName,
            programName: FUNDING_REPORT_CONFIG.programName,
            reportType: 'Quarterly Funding Report',
            reportPeriod: {
                year,
                quarter,
                startDate: dateRange.start,
                endDate: dateRange.end
            },
            generatedAt: new Date().toISOString(),
            deidentified: true,
            cellSuppressionThreshold: FUNDING_REPORT_CONFIG.cellSuppressionMin
        },
        
        volumeMetrics: {},
        documentMetrics: {},
        clinicalServiceMix: {},
        medicationUtilization: {},
        efficiencyMetrics: {},
        dataQualityMetrics: {},
        methodology: {}
    };
    
    try {
        // ============================================================
        // 1. VOLUME METRICS
        // ============================================================
        
        // Total patients in system
        const totalPatientsResult = await queryDB('SELECT COUNT(*) as count FROM patients');
        report.volumeMetrics.totalPatientsInSystem = totalPatientsResult.count;
        
        // New patients in quarter
        const newPatientsResult = await queryDB(
            'SELECT COUNT(*) as count FROM patients WHERE created_at >= ? AND created_at <= ?',
            [dateRange.start, dateRange.end + ' 23:59:59']
        );
        report.volumeMetrics.newPatientsThisQuarter = applyCellSuppression(newPatientsResult.count);
        
        // ============================================================
        // 2. DOCUMENT METRICS
        // ============================================================
        
        // Documents in quarter
        const docsInQuarter = await queryDB(
            'SELECT status FROM patient_documents WHERE created_at >= ? AND created_at <= ?',
            [dateRange.start, dateRange.end + ' 23:59:59']
        );
        
        const statusCounts = docsInQuarter.reduce((acc, doc) => {
            acc[doc.status] = (acc[doc.status] || 0) + 1;
            return acc;
        }, {});
        
        const docsUploaded = docsInQuarter.length;
        const docsProcessed = (statusCounts.extracted || 0) + (statusCounts.merged || 0);
        const docsNeedsReview = statusCounts.needs_review || 0;
        const docsError = statusCounts.error || 0;
        
        report.documentMetrics.documentsUploaded = docsUploaded;
        report.documentMetrics.documentsProcessed = docsProcessed;
        report.documentMetrics.documentsNeedingReview = docsNeedsReview;
        report.documentMetrics.documentsError = docsError;
        report.documentMetrics.autoMergeRate = docsProcessed > 0 
            ? ((docsProcessed / (docsProcessed + docsNeedsReview)) * 100).toFixed(1) + '%'
            : 'N/A';
        
        // Average confidence score
        const confidenceResult = await queryDB(`
            SELECT AVG(de.confidence) as avg_confidence
            FROM document_extractions de
            JOIN patient_documents pd ON de.document_id = pd.id
            WHERE pd.created_at >= ? AND pd.created_at <= ?
        `, [dateRange.start, dateRange.end + ' 23:59:59']);
        
        report.documentMetrics.averageConfidenceScore = confidenceResult.avg_confidence 
            ? (confidenceResult.avg_confidence * 100).toFixed(1) + '%'
            : 'N/A';
        
        // ============================================================
        // 3. CLINICAL SERVICE MIX (De-identified aggregates)
        // ============================================================
        
        // Get all patients for aggregation
        const allPatients = await queryDB('SELECT surgery_history_json, problem_list_json FROM patients');
        
        // Aggregate surgeries in quarter
        let totalSurgeriesInQuarter = 0;
        const procedureCounts = {};
        
        for (const patient of allPatients) {
            const surgeries = safeParseJSON(patient.surgery_history_json, []);
            
            for (const surgery of surgeries) {
                // Check if surgery date falls in quarter
                if (isDateInRange(surgery.date, dateRange.start, dateRange.end)) {
                    totalSurgeriesInQuarter++;
                    
                    // Count procedures
                    const procedures = surgery.procedures || (surgery.procedure ? [surgery.procedure] : []);
                    for (const proc of procedures) {
                        const normalized = proc.toLowerCase().trim();
                        procedureCounts[normalized] = (procedureCounts[normalized] || 0) + 1;
                    }
                }
            }
        }
        
        report.clinicalServiceMix.totalSurgeriesInQuarter = applyCellSuppression(totalSurgeriesInQuarter);
        
        // Top 10 procedures (with suppression)
        const topProcedures = Object.entries(procedureCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([proc, count]) => ({
                procedure: proc,
                count: applyCellSuppression(count)
            }));
        
        report.clinicalServiceMix.topProcedures = topProcedures;
        
        // Aggregate diagnoses
        const diagnosisCounts = {};
        
        for (const patient of allPatients) {
            const diagnoses = safeParseJSON(patient.problem_list_json, []);
            
            for (const dx of diagnoses) {
                const dxText = typeof dx === 'string' ? dx : (dx.name || '');
                const normalized = dxText.toLowerCase().trim();
                if (normalized.length > 0) {
                    diagnosisCounts[normalized] = (diagnosisCounts[normalized] || 0) + 1;
                }
            }
        }
        
        // Top 20 diagnoses (with suppression)
        const topDiagnoses = Object.entries(diagnosisCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([dx, count]) => ({
                diagnosis: dx,
                count: applyCellSuppression(count)
            }));
        
        report.clinicalServiceMix.topDiagnoses = topDiagnoses;
        
        // ============================================================
        // 4. MEDICATION UTILIZATION (De-identified)
        // ============================================================
        
        const allPatientsWithMeds = await queryDB('SELECT medications_json FROM patients WHERE medications_json IS NOT NULL');
        
        const medicationCounts = {};
        let patientsWithOpioids = 0;
        let patientsWithAnyMeds = 0;
        
        for (const patient of allPatientsWithMeds) {
            const medications = safeParseJSON(patient.medications_json, []);
            
            if (medications.length > 0) {
                patientsWithAnyMeds++;
                
                let hasOpioid = false;
                
                for (const med of medications) {
                    const medName = typeof med === 'string' ? med : (med.name || med.med_name || '');
                    const normalized = medName.toLowerCase().trim();
                    
                    if (normalized.length > 0) {
                        medicationCounts[normalized] = (medicationCounts[normalized] || 0) + 1;
                        
                        // Check if opioid
                        if (FUNDING_REPORT_CONFIG.opioidList.some(opioid => normalized.includes(opioid))) {
                            hasOpioid = true;
                        }
                    }
                }
                
                if (hasOpioid) patientsWithOpioids++;
            }
        }
        
        // Top 15 medications (with suppression)
        const topMedications = Object.entries(medicationCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([med, count]) => ({
                medication: med,
                count: applyCellSuppression(count)
            }));
        
        report.medicationUtilization.topMedications = topMedications;
        report.medicationUtilization.patientsWithMedications = applyCellSuppression(patientsWithAnyMeds);
        report.medicationUtilization.opioidExposureCount = applyCellSuppression(patientsWithOpioids);
        report.medicationUtilization.opioidExposureRate = patientsWithAnyMeds > 0
            ? ((patientsWithOpioids / patientsWithAnyMeds) * 100).toFixed(1) + '%'
            : 'N/A';
        
        // ============================================================
        // 5. EFFICIENCY METRICS (Cost savings)
        // ============================================================
        
        const estimatedMinutesSaved = docsProcessed * FUNDING_REPORT_CONFIG.minutesSavedPerDoc;
        const estimatedHoursSaved = estimatedMinutesSaved / 60;
        const estimatedCostSavings = estimatedHoursSaved * FUNDING_REPORT_CONFIG.staffHourlyRateUSD;
        
        report.efficiencyMetrics.documentsAutoProcessed = docsProcessed;
        report.efficiencyMetrics.estimatedStaffMinutesSaved = Math.round(estimatedMinutesSaved);
        report.efficiencyMetrics.estimatedStaffHoursSaved = estimatedHoursSaved.toFixed(1);
        report.efficiencyMetrics.estimatedCostSavingsUSD = '$' + estimatedCostSavings.toFixed(2);
        report.efficiencyMetrics.assumptions = {
            minutesSavedPerDocument: FUNDING_REPORT_CONFIG.minutesSavedPerDoc,
            staffHourlyRateUSD: FUNDING_REPORT_CONFIG.staffHourlyRateUSD,
            note: 'Estimates are conservative and based on manual intake time vs automated processing time'
        };
        
        // ============================================================
        // 6. DATA QUALITY & ACCOUNTABILITY
        // ============================================================
        
        report.dataQualityMetrics.totalDocumentsProcessed = docsProcessed;
        report.dataQualityMetrics.humanReviewRequired = docsNeedsReview;
        report.dataQualityMetrics.humanReviewRate = docsUploaded > 0
            ? ((docsNeedsReview / docsUploaded) * 100).toFixed(1) + '%'
            : 'N/A';
        report.dataQualityMetrics.errorRate = docsUploaded > 0
            ? ((docsError / docsUploaded) * 100).toFixed(1) + '%'
            : 'N/A';
        report.dataQualityMetrics.safetyFeatures = [
            'Invariant checking prevents incomplete extractions from auto-merging',
            'All extracted facts are traceable to source documents',
            'No silent failures - low confidence extractions require human review',
            'Confidence scores computed deterministically in code',
            'Quality gates reject invalid medication entries'
        ];
        report.dataQualityMetrics.auditability = 'Every extracted fact is linked to a source document with SHA-256 hash verification';
        
        // ============================================================
        // 7. METHODOLOGY
        // ============================================================
        
        report.methodology.dataSources = [
            'Patient documents uploaded during quarter',
            'Structured data extracted from clinical documents',
            'Patient chart summaries (de-identified aggregates only)'
        ];
        report.methodology.deidentification = [
            'No patient names, MRNs, addresses, phone numbers, or emails in report',
            'No document text excerpts included',
            `Cell suppression applied: counts < ${FUNDING_REPORT_CONFIG.cellSuppressionMin} shown as "<${FUNDING_REPORT_CONFIG.cellSuppressionMin}"`,
            'All metrics are aggregate counts or rates'
        ];
        report.methodology.definitions = {
            'Auto-merge rate': 'Percentage of documents successfully processed and merged without human review',
            'Confidence score': 'Code-computed score based on completeness of extraction (date, procedures, diagnoses, medications)',
            'Opioid exposure': 'Patients with at least one opioid medication documented',
            'Estimated cost savings': 'Conservative estimate based on staff time saved via automation'
        };
        report.methodology.limitations = [
            'Quarter-to-quarter comparisons may be affected by intake volume variations',
            'Medication counts reflect mentions in documents, not prescriptions or dispensing',
            'Surgery dates may not align with document upload dates',
            'Cost savings are estimates based on conservative assumptions'
        ];
        
        return report;
        
    } catch (error) {
        console.error('[FundingReport] Error generating report:', error);
        throw error;
    }
}

/**
 * Helper: Query database with promise
 */
function queryDB(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || {});
        });
    });
}

/**
 * Helper: Query database for all rows
 */
function queryDBAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

// Override queryDB to use queryDBAll where needed
async function queryDB(sql, params = []) {
    // If query contains SELECT and doesn't have LIMIT 1 or aggregate, use all()
    if (sql.trim().toUpperCase().startsWith('SELECT') && !sql.includes('COUNT(') && !sql.includes('AVG(')) {
        return queryDBAll(sql, params);
    }
    
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || {});
        });
    });
}

module.exports = {
    generateQuarterlyReport,
    FUNDING_REPORT_CONFIG,
    getQuarterDates,
    applyCellSuppression
};
