/**
 * Funding Report Controller
 * Handles API requests for quarterly funding reports
 */

const fundingReportService = require('../services/fundingReportService');

/**
 * Generate quarterly funding report
 * GET /api/reports/funding/quarterly?year=2025&quarter=4&format=json|pdf
 */
const generateQuarterlyReport = async (req, res) => {
    try {
        const { year, quarter, start, end, format = 'json' } = req.query;
        
        // Validate inputs
        if (!year || !quarter) {
            if (!start || !end) {
                return res.status(400).json({
                    error: 'Either (year + quarter) or (start + end) date range required',
                    example: '/api/reports/funding/quarterly?year=2025&quarter=4&format=json'
                });
            }
        }
        
        const yearInt = parseInt(year);
        const quarterInt = parseInt(quarter);
        
        if (quarter && (quarterInt < 1 || quarterInt > 4)) {
            return res.status(400).json({ error: 'Quarter must be 1-4' });
        }
        
        console.log(`[ReportAPI] Generating quarterly report: Y${year} Q${quarter}`);
        
        // Generate report
        const report = await fundingReportService.generateQuarterlyReport(
            yearInt,
            quarterInt,
            start,
            end
        );
        
        // Return based on format
        if (format === 'pdf') {
            // TODO: Implement PDF generation with Playwright
            return res.status(501).json({
                error: 'PDF generation not yet implemented',
                message: 'Use format=json to get raw data, then convert to PDF externally',
                report
            });
        }
        
        // Default: return JSON
        res.status(200).json(report);
        
    } catch (error) {
        console.error('[ReportAPI] Error:', error);
        res.status(500).json({
            error: 'Failed to generate funding report',
            message: error.message
        });
    }
};

/**
 * Get report configuration
 * GET /api/reports/funding/config
 */
const getReportConfig = async (req, res) => {
    try {
        res.status(200).json({
            config: fundingReportService.FUNDING_REPORT_CONFIG,
            availableQuarters: [
                { year: 2025, quarter: 4, dates: fundingReportService.getQuarterDates(2025, 4) },
                { year: 2026, quarter: 1, dates: fundingReportService.getQuarterDates(2026, 1) }
            ]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    generateQuarterlyReport,
    getReportConfig
};
