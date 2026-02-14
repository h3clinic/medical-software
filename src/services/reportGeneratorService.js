/**
 * Report Generator Service
 * Generates patient-facing report cards from document extractions
 * Signal-based, deterministic - no LLM needed
 */

class ReportGeneratorService {
    /**
     * Generate reports from a document extraction
     * @param {Object} extraction - The document_extractions.extracted_json object
     * @param {number} documentId - Document ID
     * @param {number} patientId - Patient ID
     * @returns {Array} Array of report objects to insert
     */
    static generateReports(extraction, documentId, patientId) {
        const reports = [];

        // Parse extraction if it's a string
        const rawData = typeof extraction === 'string' ? JSON.parse(extraction) : extraction;
        
        // Normalize the data structure
        const data = this._normalizeExtractionData(rawData);

        // 1. Timeline Card (if ≥2 dates exist)
        const timelineReport = this.generateTimelineCard(data, documentId, patientId);
        if (timelineReport) reports.push(timelineReport);

        // 2. Length of Stay Metric (if admission & discharge dates exist)
        const losReport = this.generateLengthOfStayCard(data, documentId, patientId);
        if (losReport) reports.push(losReport);

        // 3. Procedure Summary Card
        const procedureReport = this.generateProcedureSummaryCard(data, documentId, patientId);
        if (procedureReport) reports.push(procedureReport);

        // 4. Diagnosis Summary Card
        const diagnosisReport = this.generateDiagnosisSummaryCard(data, documentId, patientId);
        if (diagnosisReport) reports.push(diagnosisReport);

        // 5. Medication Exposure Card
        const medReport = this.generateMedicationCard(data, documentId, patientId);
        if (medReport) reports.push(medReport);

        // 6. Functional Limitations Card
        const limitationsReport = this.generateLimitationsCard(data, documentId, patientId);
        if (limitationsReport) reports.push(limitationsReport);

        // 7. Follow-up Reminders Card
        const followupReport = this.generateFollowupCard(data, documentId, patientId);
        if (followupReport) reports.push(followupReport);

        return reports;
    }

    /**
     * Generate a comprehensive "Document Render" report
     * Shows PDF + all extracted sections + graphs derived from data
     * @param {Object} document - Full document object with extraction
     * @param {Object} extraction - Parsed extraction data
     * @param {Object} validation - Validation data for section completeness
     * @returns {Object} Report object to insert/update
     */
    static generateDocumentRenderReport(document, extraction, validation = null) {
        const rawData = typeof extraction === 'string' ? JSON.parse(extraction) : extraction;
        const validationData = validation ? (typeof validation === 'string' ? JSON.parse(validation) : validation) : null;
        
        // Normalize the data structure to a flat format
        const data = this._normalizeExtractionData(rawData);
        
        const cards = [];
        
        // 1. Key Dates Metric Card
        const dateMetric = this._buildDateMetricCard(data);
        if (dateMetric) cards.push(dateMetric);
        
        // 2. Length of Stay Metric
        const losMetric = this._buildLOSMetricCard(data);
        if (losMetric) cards.push(losMetric);
        
        // 3. Timeline Chart (always safe when dates exist)
        const timeline = this._buildTimelineChartCard(data);
        if (timeline) cards.push(timeline);
        
        // 4. Preoperative Diagnoses List
        const preopDx = this._buildDiagnosisListCard(data, 'preop');
        if (preopDx) cards.push(preopDx);
        
        // 5. Postoperative Diagnoses List
        const postopDx = this._buildDiagnosisListCard(data, 'postop');
        if (postopDx) cards.push(postopDx);
        
        // 6. Procedures List
        const procedures = this._buildProceduresCard(data);
        if (procedures) cards.push(procedures);
        
        // 7. Medication Exposure Bar Chart (safe - just counts)
        const medChart = this._buildMedicationBarCard(data);
        if (medChart) cards.push(medChart);
        
        // 8. Section Completeness Donut (safe - derived from validation)
        const completeness = this._buildSectionCompletenessCard(data, validationData);
        if (completeness) cards.push(completeness);
        
        // 9. Allergies
        const allergies = this._buildAllergiesCard(data);
        if (allergies) cards.push(allergies);
        
        // 10. Clinical Highlights (top 5 relevant lines)
        const highlights = this._buildHighlightsCard(data);
        if (highlights) cards.push(highlights);
        
        // 11. Follow-up Alert
        const followup = this._buildFollowupAlertCard(data);
        if (followup) cards.push(followup);
        
        // 12. Confidence Explanation Card (debug superpower)
        const confidenceCard = this._buildConfidenceExplanationCard(data, validationData);
        if (confidenceCard) cards.push(confidenceCard);
        
        // Build document metadata
        const documentMeta = {
            document_id: document.id,
            original_filename: document.original_filename,
            pdf_url: document.stored_path ? `/uploads/${document.stored_path.split('/').pop()}` : null,
            text_url: document.text_path ? `/uploads/${document.text_path.split('/').pop()}` : null,
            status: document.status,
            created_at: document.created_at
        };
        
        // Calculate overall confidence
        const confidence = this._calculateOverallConfidence(cards, validationData);
        
        const reportJson = {
            layout: 'document_view',
            document: documentMeta,
            cards: cards,
            confidence: confidence,
            generated_at: new Date().toISOString()
        };
        
        return {
            patient_id: document.patient_id,
            document_id: document.id,
            report_type: 'document_render',
            title: document.original_filename || 'Document Report',
            subtitle: `${cards.length} sections extracted`,
            report_json: JSON.stringify(reportJson),
            confidence: confidence,
            status: confidence >= 0.7 ? 'generated' : 'needs_review'
        };
    }
    
    /**
     * Normalize extraction data from various formats to a flat structure
     * Handles both old flat format and new nested format
     */
    static _normalizeExtractionData(rawData) {
        // If already flat (has date_of_admission at top level), return as-is
        if (rawData.date_of_admission || rawData.date_of_discharge) {
            return rawData;
        }
        
        // Normalize from nested structure
        const normalized = {};
        
        // Handle doc metadata
        if (rawData.doc) {
            normalized.doc_type = rawData.doc.doc_type;
            normalized.doc_date = rawData.doc.doc_date;
            normalized.facility = rawData.doc.facility;
            normalized.provider = rawData.doc.provider;
            normalized.patient_name = rawData.doc.patient_name;
            normalized.mrn = rawData.doc.mrn;
        }
        
        // Handle surgery info
        if (rawData.surgery) {
            normalized.date_of_surgery = rawData.surgery.date;
            normalized.surgeon = rawData.surgery.surgeon;
            normalized.procedures = rawData.surgery.procedures || [];
        }
        
        // Handle diagnoses - both nested and flat formats
        if (rawData.diagnoses) {
            if (rawData.diagnoses.preop) {
                normalized.preop_diagnoses = rawData.diagnoses.preop;
            }
            if (rawData.diagnoses.postop) {
                normalized.postop_diagnoses = rawData.diagnoses.postop;
            }
            // If diagnoses is an array, use it directly
            if (Array.isArray(rawData.diagnoses)) {
                normalized.diagnoses = rawData.diagnoses;
            }
        }
        
        // Direct properties
        normalized.date_of_admission = rawData.date_of_admission || rawData.admission_date;
        normalized.date_of_discharge = rawData.date_of_discharge || rawData.discharge_date;
        normalized.medications = rawData.medications || rawData.meds || [];
        normalized.allergies = rawData.allergies || [];
        normalized.functional_limitations = rawData.functional_limitations || [];
        normalized.follow_up = rawData.follow_up || rawData.followup || '';
        normalized.summary = rawData.summary;
        normalized.evidence = rawData.evidence || {};
        
        return normalized;
    }
    
    // ===== HELPER METHODS FOR DOCUMENT_RENDER =====
    
    static _buildDateMetricCard(data) {
        const dates = [];
        if (data.date_of_admission) dates.push(`Admitted: ${data.date_of_admission}`);
        if (data.date_of_surgery) dates.push(`Surgery: ${data.date_of_surgery}`);
        if (data.date_of_discharge) dates.push(`Discharged: ${data.date_of_discharge}`);
        
        if (dates.length === 0) return null;
        
        return {
            type: 'metric',
            title: 'Key Dates',
            value: dates.join(' → '),
            displayType: 'text',
            evidence: `Extracted from document dates section`
        };
    }
    
    static _buildLOSMetricCard(data) {
        if (!data.date_of_admission || !data.date_of_discharge) return null;
        
        const admission = new Date(data.date_of_admission);
        const discharge = new Date(data.date_of_discharge);
        const days = Math.ceil((discharge - admission) / (1000 * 60 * 60 * 24));
        
        if (days < 0 || days > 365) return null;
        
        return {
            type: 'metric',
            title: 'Length of Stay',
            value: days,
            unit: days === 1 ? 'day' : 'days',
            evidence: `Date of Admission: ${data.date_of_admission}\nDate of Discharge: ${data.date_of_discharge}`
        };
    }
    
    static _buildTimelineChartCard(data) {
        const events = [];
        
        if (data.date_of_admission) {
            events.push({ date: data.date_of_admission, label: 'Admitted', type: 'admission' });
        }
        if (data.date_of_surgery) {
            events.push({ date: data.date_of_surgery, label: 'Surgery', type: 'surgery' });
        }
        if (data.date_of_discharge) {
            events.push({ date: data.date_of_discharge, label: 'Discharged', type: 'discharge' });
        }
        
        // Add follow-up window if detected
        const followup = data.follow_up || data.followup || '';
        const match = followup.match(/(\d+)[\s-](\d+)\s*(days?|weeks?)/i);
        if (match && data.date_of_discharge) {
            const dischargeDt = new Date(data.date_of_discharge);
            const followupDt = new Date(dischargeDt);
            followupDt.setDate(followupDt.getDate() + parseInt(match[2]));
            events.push({
                date: followupDt.toISOString().split('T')[0],
                label: `Follow-up (${match[1]}-${match[2]} ${match[3]})`,
                type: 'followup'
            });
        }
        
        if (events.length < 2) return null;
        
        events.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        return {
            type: 'timeline_chart',
            title: 'Care Timeline',
            events: events,
            chartType: 'horizontal_timeline'
        };
    }
    
    static _buildDiagnosisListCard(data, type = 'all') {
        let diagnoses = [];
        let title = 'Diagnoses';
        let evidenceSection = '';
        
        if (type === 'preop') {
            diagnoses = data.preop_diagnoses || data.preoperative_diagnoses || [];
            title = 'Preoperative Diagnoses';
            evidenceSection = data.evidence?.preop_dx_section || '';
        } else if (type === 'postop') {
            diagnoses = data.postop_diagnoses || data.postoperative_diagnoses || [];
            title = 'Postoperative Diagnoses';
            evidenceSection = data.evidence?.postop_dx_section || '';
        } else {
            diagnoses = data.diagnoses || data.diagnosis || [];
        }
        
        const dxArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses].filter(Boolean);
        if (dxArray.length === 0) return null;
        
        return {
            type: 'list',
            title: title,
            items: dxArray.map((dx, idx) => ({
                text: typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || 'Unknown'),
                label: typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || 'Unknown'),
                detail: typeof dx === 'object' ? (dx.code || dx.icd10 || '') : '',
                evidence: [title, typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || '')],
                evidence_location: { section: title, item: idx + 1 }
            })),
            count: dxArray.length,
            section_evidence: evidenceSection
        };
    }
    
    static _buildProceduresCard(data) {
        const procedures = data.procedures || [];
        if (!Array.isArray(procedures) || procedures.length === 0) return null;
        
        const evidenceSection = data.evidence?.procedures_section || '';
        
        return {
            type: 'list',
            title: 'Procedures Performed',
            items: procedures.map((p, idx) => ({
                text: typeof p === 'string' ? p : (p.name || p.procedure || 'Unnamed procedure'),
                label: typeof p === 'string' ? p : (p.name || p.procedure || 'Unnamed procedure'),
                detail: typeof p === 'object' ? (p.cpt_code ? `CPT: ${p.cpt_code}` : (p.date || '')) : '',
                evidence: ['Procedures Performed', typeof p === 'string' ? p : (p.name || p.procedure || '')],
                evidence_location: { section: 'Procedures Performed', item: idx + 1 }
            })),
            count: procedures.length,
            section_evidence: evidenceSection
        };
    }
    
    static _buildMedicationBarCard(data) {
        const medications = data.medications || data.meds || [];
        if (!Array.isArray(medications) || medications.length === 0) return null;
        
        // Group medications by category (if available) or just count
        const categories = {};
        medications.forEach(med => {
            const name = typeof med === 'string' ? med : (med.name || med.medication || 'Other');
            const category = typeof med === 'object' && med.category ? med.category : 'Medications';
            if (!categories[category]) categories[category] = [];
            categories[category].push(name);
        });
        
        const labels = Object.keys(categories);
        const values = labels.map(l => categories[l].length);
        
        return {
            type: 'bar_chart',
            title: 'Medication Exposure',
            chartType: 'horizontal_bar',
            labels: labels,
            values: values,
            total: medications.length,
            note: `${medications.length} medications documented`,
            items: medications.map(med => ({
                label: typeof med === 'string' ? med : (med.name || med.medication || 'Unknown'),
                detail: typeof med === 'object' ? (med.dose || med.dosage || '') : ''
            }))
        };
    }
    
    static _buildSectionCompletenessCard(data, validationData) {
        // Expected sections for a typical clinical document
        const expectedSections = [
            { key: 'date_of_admission', label: 'Admission Date' },
            { key: 'date_of_surgery', label: 'Surgery Date' },
            { key: 'date_of_discharge', label: 'Discharge Date' },
            { key: 'preop_diagnoses', label: 'Preop Diagnoses', altKeys: ['preoperative_diagnoses'] },
            { key: 'postop_diagnoses', label: 'Postop Diagnoses', altKeys: ['postoperative_diagnoses'] },
            { key: 'procedures', label: 'Procedures' },
            { key: 'medications', label: 'Medications', altKeys: ['meds'] },
            { key: 'allergies', label: 'Allergies' },
            { key: 'follow_up', label: 'Follow-up', altKeys: ['followup'] }
        ];
        
        const detected = [];
        const missing = [];
        
        expectedSections.forEach(section => {
            const keys = [section.key, ...(section.altKeys || [])];
            const found = keys.some(k => {
                const val = data[k];
                return val !== undefined && val !== null && val !== '' && 
                       (!Array.isArray(val) || val.length > 0);
            });
            
            if (found) {
                detected.push(section.label);
            } else {
                missing.push(section.label);
            }
        });
        
        const completeness = detected.length / expectedSections.length;
        
        return {
            type: 'donut_chart',
            title: 'Section Completeness',
            chartType: 'donut',
            value: Math.round(completeness * 100),
            unit: '%',
            segments: [
                { label: 'Detected', value: detected.length, color: '#48bb78' },
                { label: 'Missing', value: missing.length, color: '#e2e8f0' }
            ],
            detected: detected,
            missing: missing,
            note: `${detected.length}/${expectedSections.length} sections extracted`
        };
    }
    
    static _buildAllergiesCard(data) {
        const allergies = data.allergies || [];
        const allergyArray = Array.isArray(allergies) ? allergies : [allergies].filter(Boolean);
        
        if (allergyArray.length === 0) {
            // Show NKDA if no allergies
            if (data.nkda || /no known.*allergies|nkda/i.test(JSON.stringify(data))) {
                return {
                    type: 'alert',
                    title: 'Allergies',
                    message: 'NKDA (No Known Drug Allergies)',
                    severity: 'success'
                };
            }
            return null;
        }
        
        return {
            type: 'list',
            title: 'Allergies',
            listStyle: 'warning',
            items: allergyArray.map(a => ({
                label: typeof a === 'string' ? a : (a.name || a.allergen || 'Unknown'),
                detail: typeof a === 'object' ? (a.reaction || '') : ''
            })),
            count: allergyArray.length
        };
    }
    
    static _buildHighlightsCard(data) {
        const highlights = [];
        
        // Extract clinically relevant highlights
        if (data.summary) {
            highlights.push({ text: data.summary, source: 'Summary' });
        }
        if (data.course || data.hospital_course) {
            const course = data.course || data.hospital_course;
            const firstSentence = course.split(/[.!?]/)[0];
            if (firstSentence && firstSentence.length > 20) {
                highlights.push({ text: firstSentence + '.', source: 'Hospital Course' });
            }
        }
        if (data.complications) {
            highlights.push({ 
                text: `Complications: ${Array.isArray(data.complications) ? data.complications.join(', ') : data.complications}`,
                source: 'Complications'
            });
        }
        if (data.disposition) {
            highlights.push({ text: `Disposition: ${data.disposition}`, source: 'Disposition' });
        }
        if (data.restrictions || data.functional_limitations) {
            const restrictions = data.restrictions || data.functional_limitations;
            const text = Array.isArray(restrictions) ? restrictions.slice(0, 2).join('; ') : restrictions;
            highlights.push({ text: `Restrictions: ${text}`, source: 'Restrictions' });
        }
        
        if (highlights.length === 0) return null;
        
        return {
            type: 'highlights',
            title: 'Clinical Highlights',
            items: highlights.slice(0, 5) // Top 5
        };
    }
    
    static _buildFollowupAlertCard(data) {
        const followupText = data.follow_up || data.followup || data.plan || '';
        const hasFollowup = /follow[\s-]?up|return|revisit|appointment|10[\s-]14\s*days/i.test(followupText);
        
        if (!hasFollowup) return null;
        
        let timeframe = 'As recommended';
        const match = followupText.match(/(\d+)[\s-](\d+)\s*(days?|weeks?|months?)/i);
        if (match) {
            timeframe = `${match[1]}-${match[2]} ${match[3]}`;
        }
        
        return {
            type: 'alert',
            title: 'Follow-up Required',
            message: timeframe,
            severity: 'info',
            evidence: followupText
        };
    }
    
    /**
     * Build Confidence Explanation Card
     * Shows why confidence is what it is - detection/extraction metrics
     */
    static _buildConfidenceExplanationCard(data, validationData) {
        const explanation = {
            detected_sections: [],
            extracted_sections: [],
            missing_sections: [],
            methods_used: []
        };
        
        // Expected sections
        const sectionChecks = [
            { key: 'date_of_surgery', label: 'Surgery Date' },
            { key: 'date_of_admission', label: 'Admission Date' },
            { key: 'date_of_discharge', label: 'Discharge Date' },
            { key: 'preop_diagnoses', label: 'Preop Diagnoses' },
            { key: 'postop_diagnoses', label: 'Postop Diagnoses' },
            { key: 'procedures', label: 'Procedures' },
            { key: 'medications', label: 'Medications' },
            { key: 'allergies', label: 'Allergies' },
            { key: 'follow_up', label: 'Follow-up' },
            { key: 'functional_limitations', label: 'Functional Limitations' },
            { key: 'summary', label: 'Summary' }
        ];
        
        sectionChecks.forEach(check => {
            const val = data[check.key];
            const hasValue = val !== undefined && val !== null && val !== '' && 
                           (!Array.isArray(val) || val.length > 0);
            if (hasValue) {
                explanation.extracted_sections.push(check.label);
                explanation.detected_sections.push(check.label);
            } else {
                explanation.missing_sections.push(check.label);
            }
        });
        
        // Check validation data for invariants
        if (validationData) {
            const invariants = validationData.invariants || {};
            if (invariants.preop_diagnoses_header_exists) explanation.methods_used.push('Header-based extraction');
            if (invariants.procedures_header_exists) explanation.methods_used.push('Procedure header found');
        }
        
        // Check methods used
        if (data.medications && data.medications.length > 0) {
            explanation.methods_used.push('Medication regex extraction');
        }
        if (data.evidence && Object.keys(data.evidence).length > 0) {
            explanation.methods_used.push('Section slicing');
        }
        
        const detectedCount = explanation.detected_sections.length;
        const extractedCount = explanation.extracted_sections.length;
        const missingCount = explanation.missing_sections.length;
        const totalSections = sectionChecks.length;
        
        const confidenceScore = Math.round((extractedCount / totalSections) * 100);
        const needsReview = confidenceScore < 70 || missingCount > 5;
        
        return {
            type: 'confidence_explanation',
            title: `Why Confidence is ${confidenceScore}%`,
            value: confidenceScore,
            severity: needsReview ? 'warning' : 'success',
            stats: {
                detected_sections: detectedCount,
                extracted_sections: extractedCount,
                missing_sections: missingCount,
                total_sections: totalSections
            },
            detected: explanation.detected_sections,
            missing: explanation.missing_sections,
            methods_used: [...new Set(explanation.methods_used)],
            needs_review: needsReview,
            review_reasons: needsReview ? 
                (missingCount > 5 ? [`${missingCount} critical sections missing`] : ['Low confidence score']) : []
        };
    }
    
    static _calculateOverallConfidence(cards, validationData) {
        if (cards.length === 0) return 0.3;
        
        let score = 0.5; // Base score
        
        // Add points for each card type
        const hasTimeline = cards.some(c => c.type === 'timeline_chart');
        const hasMetrics = cards.some(c => c.type === 'metric');
        const hasDiagnoses = cards.some(c => c.title?.includes('Diagnoses'));
        const hasProcedures = cards.some(c => c.title?.includes('Procedures'));
        
        if (hasTimeline) score += 0.1;
        if (hasMetrics) score += 0.1;
        if (hasDiagnoses) score += 0.1;
        if (hasProcedures) score += 0.1;
        
        // Check section completeness
        const completenessCard = cards.find(c => c.type === 'donut_chart');
        if (completenessCard && completenessCard.value >= 60) {
            score += 0.1;
        }
        
        return Math.min(score, 0.95);
    }

    /**
     * Generate Timeline Card
     */
    static generateTimelineCard(data, documentId, patientId) {
        const events = [];

        // Extract dates from various fields
        if (data.date_of_admission) {
            events.push({
                date: data.date_of_admission,
                label: 'Admitted',
                evidence: `Date of Admission: ${data.date_of_admission}`
            });
        }

        if (data.date_of_surgery) {
            events.push({
                date: data.date_of_surgery,
                label: 'Surgery',
                evidence: `Date of Surgery: ${data.date_of_surgery}`
            });
        }

        if (data.date_of_discharge) {
            events.push({
                date: data.date_of_discharge,
                label: 'Discharged',
                evidence: `Date of Discharge: ${data.date_of_discharge}`
            });
        }

        // Add procedure dates if available
        if (data.procedures && Array.isArray(data.procedures)) {
            data.procedures.forEach(proc => {
                if (proc.date) {
                    events.push({
                        date: proc.date,
                        label: proc.name || 'Procedure',
                        evidence: `Procedure: ${proc.name || 'Unknown'} on ${proc.date}`
                    });
                }
            });
        }

        // Only create timeline if we have 2+ events
        if (events.length < 2) return null;

        // Sort by date
        events.sort((a, b) => new Date(a.date) - new Date(b.date));

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'timeline',
                title: 'Key Events',
                events: events
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'timeline',
            title: 'Key Events Timeline',
            subtitle: `${events.length} events`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.9,
            status: 'generated'
        };
    }

    /**
     * Generate Length of Stay Card
     */
    static generateLengthOfStayCard(data, documentId, patientId) {
        if (!data.date_of_admission || !data.date_of_discharge) return null;

        const admission = new Date(data.date_of_admission);
        const discharge = new Date(data.date_of_discharge);
        const days = Math.ceil((discharge - admission) / (1000 * 60 * 60 * 24));

        if (days < 0 || days > 365) return null; // Sanity check

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'metric',
                title: 'Length of Stay',
                value: days,
                unit: days === 1 ? 'day' : 'days',
                evidence: `Date of Admission: ${data.date_of_admission}\nDate of Discharge: ${data.date_of_discharge}`
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'postop_summary',
            title: 'Length of Stay',
            subtitle: `${days} ${days === 1 ? 'day' : 'days'}`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.95,
            status: 'generated'
        };
    }

    /**
     * Generate Procedure Summary Card
     */
    static generateProcedureSummaryCard(data, documentId, patientId) {
        const procedures = data.procedures || [];
        if (!Array.isArray(procedures) || procedures.length === 0) return null;

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'list',
                title: 'Procedures Performed',
                items: procedures.map(p => ({
                    label: typeof p === 'string' ? p : (p.name || p.procedure || 'Unnamed procedure'),
                    detail: typeof p === 'object' ? (p.date || '') : '',
                    evidence: typeof p === 'object' ? (p.evidence || '') : ''
                }))
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'procedure_summary',
            title: 'Procedures',
            subtitle: `${procedures.length} procedure${procedures.length !== 1 ? 's' : ''}`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.85,
            status: 'generated'
        };
    }

    /**
     * Generate Diagnosis Summary Card
     */
    static generateDiagnosisSummaryCard(data, documentId, patientId) {
        const diagnoses = data.diagnoses || data.diagnosis || [];
        const dxArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses].filter(Boolean);
        
        if (dxArray.length === 0) return null;

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'list',
                title: 'Diagnoses',
                items: dxArray.map(dx => {
                    const label = typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || 'Unknown');
                    const detail = typeof dx === 'object' ? (dx.code || '') : '';
                    return { label, detail, evidence: dx.evidence || '' };
                })
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'diagnosis_summary',
            title: 'Diagnoses',
            subtitle: `${dxArray.length} diagnosis${dxArray.length !== 1 ? 'es' : ''}`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.85,
            status: 'generated'
        };
    }

    /**
     * Generate Medication Exposure Card
     */
    static generateMedicationCard(data, documentId, patientId) {
        const medications = data.medications || data.meds || [];
        if (!Array.isArray(medications) || medications.length === 0) return null;

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'list',
                title: 'Medications',
                items: medications.map(med => {
                    const label = typeof med === 'string' ? med : (med.name || med.medication || 'Unknown medication');
                    const detail = typeof med === 'object' ? (med.dose || med.dosage || '') : '';
                    return { label, detail, evidence: med.evidence || '' };
                })
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'med_timeline',
            title: 'Medications',
            subtitle: `${medications.length} medication${medications.length !== 1 ? 's' : ''}`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.8,
            status: 'generated'
        };
    }

    /**
     * Generate Functional Limitations Card
     */
    static generateLimitationsCard(data, documentId, patientId) {
        const limitations = data.functional_limitations || data.limitations || data.restrictions || [];
        const limitArray = Array.isArray(limitations) ? limitations : [limitations].filter(Boolean);

        if (limitArray.length === 0) return null;

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'list',
                title: 'Functional Limitations',
                items: limitArray.map(limit => {
                    const label = typeof limit === 'string' ? limit : (limit.description || limit.limitation || 'Unknown');
                    const detail = typeof limit === 'object' ? (limit.duration || '') : '';
                    return { label, detail, evidence: limit.evidence || '' };
                })
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'restrictions',
            title: 'Functional Limitations',
            subtitle: `${limitArray.length} restriction${limitArray.length !== 1 ? 's' : ''}`,
            report_json: JSON.stringify(reportJson),
            confidence: 0.85,
            status: 'generated'
        };
    }

    /**
     * Generate Follow-up Reminders Card
     */
    static generateFollowupCard(data, documentId, patientId) {
        const followupText = data.follow_up || data.followup || data.plan || '';
        
        // Check if follow-up is mentioned
        const hasFollowup = /follow[\s-]?up|return|revisit|appointment|10[\s-]14\s*days/i.test(followupText);
        
        if (!hasFollowup) return null;

        // Try to extract timeframe
        let timeframe = 'As recommended';
        const match = followupText.match(/(\d+)[\s-](\d+)\s*(days?|weeks?|months?)/i);
        if (match) {
            timeframe = `${match[1]}-${match[2]} ${match[3]}`;
        }

        const reportJson = {
            layout: 'cards',
            cards: [{
                type: 'alert',
                title: 'Follow-up Required',
                message: timeframe,
                evidence: followupText,
                severity: 'info'
            }]
        };

        return {
            patient_id: patientId,
            document_id: documentId,
            report_type: 'followup_reminder',
            title: 'Follow-up Required',
            subtitle: timeframe,
            report_json: JSON.stringify(reportJson),
            confidence: 0.75,
            status: 'generated'
        };
    }

    // =========================================================================
    // v2: DOCUMENT DIGEST (one-page summary for doctors/printing)
    // =========================================================================
    
    /**
     * Generate a comprehensive one-page document digest
     * This is the "hand to doctor" or "print" view
     * @param {Object} document - Full document object
     * @param {Object} extraction - Parsed extraction data
     * @param {Object} validation - Validation data with field_confidence
     * @returns {Object} Report object
     */
    static generateDocumentDigest(document, extraction, validation = null) {
        const rawData = typeof extraction === 'string' ? JSON.parse(extraction) : extraction;
        const validationData = validation ? (typeof validation === 'string' ? JSON.parse(validation) : validation) : null;
        const data = this._normalizeExtractionData(rawData);
        
        const sections = [];
        
        // 1. Header/Metadata section
        sections.push({
            type: 'header',
            title: 'Document Summary',
            metadata: {
                document_type: data.doc_type || 'Medical Document',
                facility: data.facility || 'Unknown',
                provider: data.provider || data.surgeon || 'Unknown',
                patient_name: data.patient_name || 'See chart',
                mrn: data.mrn || 'N/A',
                document_date: data.doc_date || data.date_of_surgery || 'Unknown'
            }
        });
        
        // 2. Key Dates (compact)
        const keyDates = [];
        if (data.date_of_admission) keyDates.push({ label: 'Admitted', value: data.date_of_admission });
        if (data.date_of_surgery) keyDates.push({ label: 'Surgery', value: data.date_of_surgery });
        if (data.date_of_discharge) keyDates.push({ label: 'Discharged', value: data.date_of_discharge });
        
        if (keyDates.length > 0) {
            sections.push({
                type: 'key_dates',
                title: 'Key Dates',
                dates: keyDates,
                confidence: validationData?.field_confidence?.surgery_date || 0.9
            });
        }
        
        // 3. Top 5 Highlights (most important info)
        const highlights = this._extractHighlights(data, 5);
        if (highlights.length > 0) {
            sections.push({
                type: 'highlights',
                title: 'Key Findings',
                items: highlights
            });
        }
        
        // 4. Procedures (with evidence)
        const procedures = data.procedures || data.surgery?.procedures || [];
        if (procedures.length > 0) {
            sections.push({
                type: 'procedures',
                title: 'Procedures Performed',
                items: procedures.map(p => typeof p === 'string' ? p : p.name || p.procedure || String(p)),
                confidence: validationData?.field_confidence?.procedures || 0.85,
                evidence: data.evidence?.surgery?.procedures || null
            });
        }
        
        // 5. Diagnoses (preop + postop combined)
        const preopDx = data.preop_diagnoses || data.diagnoses?.preop || [];
        const postopDx = data.postop_diagnoses || data.diagnoses?.postop || [];
        
        if (preopDx.length > 0 || postopDx.length > 0) {
            sections.push({
                type: 'diagnoses',
                title: 'Diagnoses',
                preop: preopDx.map(d => typeof d === 'string' ? d : d.name || String(d)),
                postop: postopDx.map(d => typeof d === 'string' ? d : d.name || String(d)),
                confidence: validationData?.field_confidence?.preop_dx || 0.85
            });
        }
        
        // 6. Restrictions/Limitations
        const restrictions = data.functional_limitations || data.restrictions || [];
        if (restrictions.length > 0) {
            sections.push({
                type: 'restrictions',
                title: 'Restrictions & Limitations',
                items: restrictions.map(r => typeof r === 'string' ? r : r.description || String(r))
            });
        }
        
        // 7. Follow-up
        const followup = data.follow_up || data.followup || '';
        if (followup) {
            const timeMatch = followup.match(/(\d+)[\s-](\d+)\s*(days?|weeks?)/i);
            sections.push({
                type: 'followup',
                title: 'Follow-up',
                text: followup,
                timeframe: timeMatch ? `${timeMatch[1]}-${timeMatch[2]} ${timeMatch[3]}` : null
            });
        }
        
        // 8. Medications (SAFE - with unknown placeholders)
        const meds = this._safeMedicationExtraction(data.medications || []);
        if (meds.length > 0) {
            sections.push({
                type: 'medications',
                title: 'Medications',
                items: meds,
                confidence: validationData?.field_confidence?.medications || 0.6,
                warning: meds.some(m => m.dose === 'unknown') ? 'Some dosing information unavailable - verify with source' : null
            });
        }
        
        // 9. Allergies
        const allergies = data.allergies || [];
        if (allergies.length > 0) {
            sections.push({
                type: 'allergies',
                title: 'Allergies',
                items: allergies.map(a => typeof a === 'string' ? a : a.substance || String(a)),
                confidence: validationData?.field_confidence?.allergies || 0.9
            });
        }
        
        // 10. Opioid/Sedation Alert (safety feature)
        const opioidAlert = this._checkOpioidAlert(data);
        if (opioidAlert) {
            sections.push(opioidAlert);
        }
        
        // Build report
        const reportJson = {
            layout: 'document_digest',
            printable: true,
            sections: sections,
            missing_fields: validationData?.missing_fields || [],
            generated_at: new Date().toISOString(),
            source: {
                document_id: document.id,
                filename: document.original_filename,
                pdf_url: document.stored_path ? `/uploads/${document.stored_path.split('/').pop()}` : null
            }
        };
        
        // Calculate confidence
        let confidence = 0.5;
        if (procedures.length > 0) confidence += 0.15;
        if (preopDx.length > 0 || postopDx.length > 0) confidence += 0.15;
        if (keyDates.length >= 2) confidence += 0.1;
        if (allergies.length > 0) confidence += 0.05;
        confidence = Math.min(confidence, 0.95);
        
        return {
            patient_id: document.patient_id,
            document_id: document.id,
            report_type: 'document_digest',
            title: `${data.doc_type || 'Document'} Summary`,
            subtitle: `${sections.length} sections • ${highlights.length} key findings`,
            report_json: JSON.stringify(reportJson),
            confidence: confidence,
            status: confidence >= 0.7 ? 'generated' : 'needs_review'
        };
    }
    
    /**
     * Extract top N highlights from document data
     */
    static _extractHighlights(data, maxCount = 5) {
        const highlights = [];
        
        // Add surgery info as highlight
        if (data.date_of_surgery) {
            const procedures = data.procedures || data.surgery?.procedures || [];
            if (procedures.length > 0) {
                highlights.push({
                    icon: '🔪',
                    text: `Surgery on ${data.date_of_surgery}: ${procedures[0]}`,
                    importance: 'high'
                });
            }
        }
        
        // Length of stay
        if (data.date_of_admission && data.date_of_discharge) {
            const days = Math.ceil((new Date(data.date_of_discharge) - new Date(data.date_of_admission)) / (1000 * 60 * 60 * 24));
            if (days > 0 && days < 365) {
                highlights.push({
                    icon: '🏥',
                    text: `Hospital stay: ${days} day${days !== 1 ? 's' : ''}`,
                    importance: 'medium'
                });
            }
        }
        
        // Primary diagnosis
        const preopDx = data.preop_diagnoses || data.diagnoses?.preop || [];
        if (preopDx.length > 0) {
            const dx = typeof preopDx[0] === 'string' ? preopDx[0] : preopDx[0].name || String(preopDx[0]);
            highlights.push({
                icon: '📋',
                text: `Primary diagnosis: ${dx}`,
                importance: 'high'
            });
        }
        
        // Allergies (critical safety info)
        const allergies = data.allergies || [];
        if (allergies.length > 0) {
            const allergyText = allergies.map(a => typeof a === 'string' ? a : a.substance).join(', ');
            highlights.push({
                icon: '⚠️',
                text: `Allergies: ${allergyText}`,
                importance: 'critical'
            });
        }
        
        // Follow-up
        const followup = data.follow_up || data.followup || '';
        const timeMatch = followup.match(/(\d+)[\s-](\d+)\s*(days?|weeks?)/i);
        if (timeMatch) {
            highlights.push({
                icon: '📅',
                text: `Follow-up: ${timeMatch[1]}-${timeMatch[2]} ${timeMatch[3]}`,
                importance: 'medium'
            });
        }
        
        return highlights.slice(0, maxCount);
    }
    
    /**
     * SAFE medication extraction - never guess dose/route/frequency
     * Only populate fields if explicitly present in source
     */
    static _safeMedicationExtraction(medications) {
        return medications.map(med => {
            if (typeof med === 'string') {
                // Extract only the medication name, mark everything else unknown
                const name = med.split(/\s+\d/)[0].trim(); // Stop at first number (likely dose)
                return {
                    name: name || med,
                    dose: 'unknown',
                    route: 'unknown',
                    frequency: 'unknown',
                    safe_extraction: true
                };
            }
            
            // Object format - only keep explicitly present fields
            return {
                name: med.name || med.medication || 'Unknown',
                dose: (med.dose && med.dose !== '' && !/unknown/i.test(med.dose)) ? med.dose : 'unknown',
                route: (med.route && med.route !== '' && !/unknown/i.test(med.route)) ? med.route : 'unknown',
                frequency: (med.frequency && med.frequency !== '' && !/unknown/i.test(med.frequency)) ? med.frequency : 'unknown',
                safe_extraction: true
            };
        });
    }
    
    /**
     * Check for opioid/sedation mentions and create alert card
     */
    static _checkOpioidAlert(data) {
        const opioidPatterns = [
            /morphine/i, /hydromorphone/i, /oxycodone/i, /fentanyl/i,
            /hydrocodone/i, /codeine/i, /tramadol/i, /dilaudid/i,
            /percocet/i, /vicodin/i, /norco/i, /opioid/i
        ];
        
        const sedationPatterns = [
            /sedation/i, /drowsy/i, /drowsiness/i, /no\s+driving/i,
            /do\s+not\s+drive/i, /impaired/i, /somnolence/i
        ];
        
        const meds = data.medications || [];
        const allText = JSON.stringify(data).toLowerCase();
        
        // Check for opioids in medications
        const foundOpioids = [];
        for (const med of meds) {
            const medName = typeof med === 'string' ? med : (med.name || '');
            for (const pattern of opioidPatterns) {
                if (pattern.test(medName)) {
                    foundOpioids.push(medName);
                    break;
                }
            }
        }
        
        // Check for sedation warnings in text
        const hasSedationWarning = sedationPatterns.some(p => p.test(allText));
        
        if (foundOpioids.length > 0 || hasSedationWarning) {
            return {
                type: 'alert',
                severity: 'warning',
                title: '⚠️ Sedation Risk Alert',
                message: foundOpioids.length > 0 
                    ? `Opioid medications detected: ${foundOpioids.join(', ')}. Patient may experience sedation.`
                    : 'Document mentions sedation or driving restrictions.',
                recommendations: [
                    'No driving or operating heavy machinery',
                    'Avoid alcohol',
                    'May cause drowsiness',
                    'Keep medication secure'
                ],
                evidence: foundOpioids.join(', ') || 'See document text'
            };
        }
        
        return null;
    }
}

module.exports = ReportGeneratorService;
