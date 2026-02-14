/**
 * Test script for Patient Reports System
 * Run with: node tests/test-reports.js
 */

const ReportGeneratorService = require('../src/services/reportGeneratorService');

// Sample extraction data (based on your knee surgery doc)
const sampleExtraction = {
    date_of_admission: "2025-09-17",
    date_of_surgery: "2025-09-18",
    date_of_discharge: "2025-09-21",
    procedures: [
        {
            name: "Total Knee Replacement (Right)",
            date: "2025-09-18",
            evidence: "Procedure: Right total knee arthroplasty"
        }
    ],
    diagnoses: [
        "Severe osteoarthritis of the right knee",
        "Post-operative pain management"
    ],
    medications: [
        {
            name: "Oxycodone",
            dose: "5-10 mg every 4-6 hours",
            evidence: "Pain management: Oxycodone 5-10 mg"
        },
        {
            name: "Enoxaparin",
            dose: "40 mg subcutaneous daily",
            evidence: "DVT prophylaxis: Enoxaparin 40 mg"
        }
    ],
    functional_limitations: [
        "No weight-bearing on right leg for 48 hours",
        "Use walker for ambulation",
        "Avoid stairs initially"
    ],
    follow_up: "Follow-up appointment in 10-14 days for suture removal and wound check"
};

console.log('🧪 Testing Report Generator Service\n');
console.log('=' .repeat(60));

// Generate reports
const reports = ReportGeneratorService.generateReports(
    sampleExtraction,
    1, // documentId
    1  // patientId
);

console.log(`\n✅ Generated ${reports.length} reports:\n`);

reports.forEach((report, idx) => {
    console.log(`${idx + 1}. ${report.title}`);
    console.log(`   Type: ${report.report_type}`);
    console.log(`   Subtitle: ${report.subtitle}`);
    console.log(`   Confidence: ${report.confidence}`);
    console.log(`   Status: ${report.status}`);
    
    // Parse and show report structure
    const reportData = JSON.parse(report.report_json);
    console.log(`   Cards: ${reportData.cards.length}`);
    reportData.cards.forEach(card => {
        console.log(`      - ${card.type}: ${card.title || 'Untitled'}`);
    });
    console.log('');
});

console.log('=' .repeat(60));
console.log('\n📊 Sample Report JSON:\n');
console.log(JSON.stringify(JSON.parse(reports[0].report_json), null, 2));

console.log('\n✅ Test completed successfully!');
console.log('\nNext steps:');
console.log('1. Run migration: node database/migrations/002_patient_reports.js');
console.log('2. Start server: npm start');
console.log('3. View reports: http://localhost:3000/patient-reports.html?patientId=1');
