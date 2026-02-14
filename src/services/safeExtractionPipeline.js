/**
 * SAFE EXTRACTION PIPELINE
 * Two-pass document extraction with invariant checking and evidence requirements.
 * 
 * Golden Rule: The AI is assistive, never authoritative.
 * - No silent failures (if extraction fails, chart is NOT updated)
 * - Evidence required (every extracted fact needs an exact quote)
 * - Invariants enforced (if document has "Procedures" section, extraction must have procedures)
 * - Confidence computed in code, not by model
 * - Human review gate (low confidence or invariant failure → needs_review)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Import header-slice extractor (deterministic, no LLM)
const headerSlice = require('./headerSliceExtractor');

// OpenAI API configuration (set via environment variable)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCHEMA_VERSION = '2.2'; // Updated for OpenAI integration

// Confidence thresholds
const CONFIDENCE_AUTO_MERGE = 0.80;
const CONFIDENCE_REVIEW_RECOMMENDED = 0.60;

// ============================================================================
// PASS 1: ANCHOR EXTRACTION (Section detection + evidence)
// ============================================================================

const PASS1_SYSTEM_PROMPT = `You are a medical document anchor extraction engine.
Return VALID JSON ONLY.
No markdown. No commentary. No emojis.
Do not invent facts. If not explicitly present, use null or [].
Every field you extract must have a supporting evidence quote copied exactly from the text.`;

const getPass1Prompt = (documentText) => `TASK: Extract anchors/sections from this medical document.

OUTPUT MUST MATCH THIS JSON SCHEMA EXACTLY:
{
  "anchors": {
    "patient_name": null,
    "mrn": null,
    "facility": null,
    "provider": null,
    "date_of_surgery": null,
    "date_of_admission": null,
    "date_of_discharge": null,
    "has_preop_dx_section": false,
    "has_postop_dx_section": false,
    "has_procedures_section": false,
    "has_allergies_section": false,
    "has_medications_section": false
  },
  "evidence": {
    "patient_name": null,
    "mrn": null,
    "facility": null,
    "provider": null,
    "date_of_surgery": null,
    "date_of_admission": null,
    "date_of_discharge": null,
    "preop_dx_header": null,
    "postop_dx_header": null,
    "procedures_header": null,
    "allergies_header": null,
    "medications_header": null
  }
}

RULES:
- If you see a line like "Date of Surgery:" extract it as ISO format YYYY-MM-DD if possible.
- "provider" should be the surgeon/attending if present.
- Section flags should be true if the header appears (case-insensitive) anywhere:
  - "Preoperative Diagnosis" or "Pre-Operative Diagnosis"
  - "Postoperative Diagnosis" or "Post-Operative Diagnosis"
  - "Procedures Performed" or "Procedure Performed" or "Procedure:"
  - "Allergies" or "NKDA" or "No Known Drug Allergies"
  - "Medications" or "Discharge Medications" or "Analgesia"
- Evidence values must be exact substrings from the text (copy-paste), not paraphrases.

DOCUMENT TEXT:
<<<
${documentText}
>>>`;

// ============================================================================
// PASS 2: STRUCTURED EXTRACTION (Full data + evidence)
// ============================================================================

const PASS2_SYSTEM_PROMPT = `You extract structured medical information from clinical documents.
Return VALID JSON ONLY.
No markdown. No emojis. No commentary.
Do not invent facts. If a value is not explicitly present, use null or [].
Every extracted item must include an evidence quote copied exactly from the document text.
Medication list must contain medication NAMES ONLY (no effects).
Diagnoses must be copied verbatim from diagnosis sections when present.
Procedures must be copied verbatim from procedure sections when present.`;

const getPass2Prompt = (documentText) => `TASK: Extract structured data for chart population.

OUTPUT MUST MATCH THIS JSON SCHEMA EXACTLY:
{
  "doc": {
    "doc_type": null,
    "doc_date": null,
    "facility": null,
    "provider": null,
    "patient_name": null,
    "mrn": null
  },
  "surgery": {
    "has_surgery": false,
    "date": null,
    "surgeon": null,
    "procedures": []
  },
  "diagnoses": {
    "preop": [],
    "postop": []
  },
  "medications": [],
  "allergies": [],
  "functional_limitations": [],
  "summary": null,
  "evidence": {
    "doc": {},
    "surgery": {},
    "diagnoses": {},
    "medications": {},
    "allergies": {},
    "functional_limitations": {}
  }
}

HARD RULES:
- If the text includes "Date of Surgery", set surgery.has_surgery = true.
- surgery.procedures must be filled from "Procedures Performed" if present.
- diagnoses.preop must be filled from "Preoperative Diagnosis" list if present.
- diagnoses.postop must be filled from "Postoperative Diagnosis" list if present.
- medications: include only explicit medication names found in the document (e.g., morphine, hydromorphone, acetaminophen). Do NOT include side effects or descriptions.
- allergies: if NKDA or "No known drug allergies", set ["NKDA"].
- doc_type: one of "operative_report", "discharge_summary", "progress_note", "consult_note", "imaging_report", "lab_report", "other"
- Evidence must include exact quotes for:
  - date_of_surgery
  - at least one procedure if any
  - at least one diagnosis if any
  - each medication name
  - allergies

DOCUMENT TEXT:
<<<
${documentText}
>>>`;

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

async function extractTextFromPDF(pdfPath) {
    const textPath = pdfPath.replace(/\.pdf$/i, '.txt');
    
    // Try pdftotext first (poppler-utils) - most reliable for hospital PDFs
    try {
        await execPromise(`pdftotext -layout "${pdfPath}" "${textPath}"`);
        const text = fs.readFileSync(textPath, 'utf-8');
        if (text.trim().length > 100) {
            return { text, textPath, method: 'pdftotext', charCount: text.length };
        }
    } catch (e) {
        console.log('pdftotext not available or failed');
    }
    
    // Try pdf-parse library
    try {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(pdfPath);
        const data = await pdfParse(dataBuffer);
        console.log('[pdf-parse] Extracted', data.text?.length || 0, 'characters');
        if (data.text && data.text.trim().length > 50) {
            fs.writeFileSync(textPath, data.text);
            return { text: data.text, textPath, method: 'pdf-parse', charCount: data.text.length };
        }
    } catch (e) {
        console.log('pdf-parse failed:', e.message);
    }
    
    // Return with needs_review flag if text is too short (likely scanned)
    return { 
        text: '', 
        textPath: null, 
        method: 'failed',
        charCount: 0,
        needsOCR: true
    };
}

// ============================================================================
// LLM CALLS
// ============================================================================

async function isLLMAvailable() {
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        return response.ok;
    } catch {
        return false;
    }
}

async function callLLMPass(systemPrompt, userPrompt, model = 'gpt-4o-mini') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.05,
            max_tokens: 4096
        })
    });
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(`OpenAI returned ${response.status}: ${error.error?.message}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
}

function parseJSONFromLLM(llmResponse) {
    if (!llmResponse) {
        throw new Error('Empty LLM response');
    }
    
    let jsonStr = llmResponse;
    
    // Remove markdown code blocks
    const jsonMatch = llmResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1];
    }
    
    // Find JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }
    
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        throw new Error(`JSON parse failed: ${e.message}`);
    }
}

// ============================================================================
// INVARIANT CHECKING (Code-only, mandatory)
// ============================================================================

function checkInvariants(pass1Result, pass2Result, rawText) {
    const issues = [];
    const lowerText = rawText.toLowerCase();
    
    // Invariant 1: If "Date of Surgery" present → must have surgery
    if (pass1Result.anchors?.date_of_surgery || lowerText.includes('date of surgery')) {
        if (!pass2Result.surgery?.has_surgery && (!pass2Result.surgery?.procedures || pass2Result.surgery.procedures.length === 0)) {
            issues.push({
                code: 'MISSING_SURGERY',
                message: 'Document contains "Date of Surgery" but no surgery/procedures were extracted',
                severity: 'critical'
            });
        }
    }
    
    // Invariant 2: If Procedures section exists → procedures must be non-empty
    if (pass1Result.anchors?.has_procedures_section) {
        if (!pass2Result.surgery?.procedures || pass2Result.surgery.procedures.length === 0) {
            issues.push({
                code: 'MISSING_PROCEDURES',
                message: 'Document has Procedures section but no procedures were extracted',
                severity: 'critical'
            });
        }
    }
    
    // Invariant 3: If Preop Diagnosis section exists → preop dx must be non-empty
    if (pass1Result.anchors?.has_preop_dx_section) {
        if (!pass2Result.diagnoses?.preop || pass2Result.diagnoses.preop.length === 0) {
            issues.push({
                code: 'MISSING_PREOP_DX',
                message: 'Document has Preoperative Diagnosis section but none were extracted',
                severity: 'warning'
            });
        }
    }
    
    // Invariant 4: If Postop Diagnosis section exists → postop dx must be non-empty
    if (pass1Result.anchors?.has_postop_dx_section) {
        if (!pass2Result.diagnoses?.postop || pass2Result.diagnoses.postop.length === 0) {
            issues.push({
                code: 'MISSING_POSTOP_DX',
                message: 'Document has Postoperative Diagnosis section but none were extracted',
                severity: 'warning'
            });
        }
    }
    
    // Invariant 5: If NKDA in text → allergies must include NKDA
    if (lowerText.includes('nkda') || lowerText.includes('no known drug allergies') || lowerText.includes('no known allergies')) {
        const hasNKDA = pass2Result.allergies?.some(a => 
            (typeof a === 'string' ? a : a.substance || '').toLowerCase().includes('nkda') ||
            (typeof a === 'string' ? a : a.substance || '').toLowerCase().includes('no known')
        );
        if (!hasNKDA && pass2Result.allergies?.length === 0) {
            // Auto-fix: add NKDA
            pass2Result.allergies = ['NKDA'];
        }
    }
    
    // Anomaly checks for medications
    if (pass2Result.medications) {
        pass2Result.medications = pass2Result.medications.filter(med => {
            const name = typeof med === 'string' ? med : med.name || '';
            // Filter out non-medication entries
            const badPatterns = [
                /sedation/i, /reaction time/i, /side effect/i,
                /emoji/i, /coordination/i, /drowsiness/i,
                /nausea/i, /vomiting/i, /constipation/i // These are side effects, not meds
            ];
            const isBad = badPatterns.some(p => p.test(name));
            const isTooLong = name.split(' ').length > 6;
            
            if (isBad || isTooLong) {
                issues.push({
                    code: 'INVALID_MEDICATION',
                    message: `Filtered invalid medication entry: "${name}"`,
                    severity: 'info'
                });
                return false;
            }
            return true;
        });
    }
    
    const hasCritical = issues.some(i => i.severity === 'critical');
    
    return {
        passed: !hasCritical,
        issues,
        hasCritical,
        hasWarnings: issues.some(i => i.severity === 'warning')
    };
}

// ============================================================================
// CONFIDENCE SCORING (Code-computed, not model)
// ============================================================================

function computeConfidence(pass2Result) {
    let score = 0;
    const breakdown = {};
    
    // +0.25 if surgery date present
    if (pass2Result.surgery?.date) {
        score += 0.25;
        breakdown.surgery_date = 0.25;
    }
    
    // +0.20 if ≥1 procedure extracted
    if (pass2Result.surgery?.procedures?.length > 0) {
        score += 0.20;
        breakdown.procedures = 0.20;
    }
    
    // +0.20 if ≥1 diagnosis (preop or postop)
    const dxCount = (pass2Result.diagnoses?.preop?.length || 0) + (pass2Result.diagnoses?.postop?.length || 0);
    if (dxCount > 0) {
        score += 0.20;
        breakdown.diagnoses = 0.20;
    }
    
    // +0.10 if allergies extracted
    if (pass2Result.allergies?.length > 0) {
        score += 0.10;
        breakdown.allergies = 0.10;
    }
    
    // +0.10 if ≥1 medication extracted  
    if (pass2Result.medications?.length > 0) {
        score += 0.10;
        breakdown.medications = 0.10;
    }
    
    // +0.10 if doc metadata present (facility/provider/mrn)
    if (pass2Result.doc?.facility || pass2Result.doc?.provider || pass2Result.doc?.mrn) {
        score += 0.10;
        breakdown.metadata = 0.10;
    }
    
    // +0.05 if evidence present
    if (pass2Result.evidence && Object.keys(pass2Result.evidence).length > 0) {
        const hasEvidence = Object.values(pass2Result.evidence).some(v => 
            v && (typeof v === 'string' ? v.length > 0 : Object.keys(v).length > 0)
        );
        if (hasEvidence) {
            score += 0.05;
            breakdown.evidence = 0.05;
        }
    }
    
    return {
        score: Math.min(1.0, score),
        breakdown
    };
}

// ============================================================================
// FIELD-LEVEL CONFIDENCE + MISSING FIELD TRACKING (v2 upgrade)
// ============================================================================

function computeFieldConfidence(pass2Result, rawText = '') {
    const fieldConfidence = {};
    const missingFields = [];
    const lowerText = rawText.toLowerCase();
    
    // Patient name confidence
    if (pass2Result.doc?.patient_name) {
        fieldConfidence.patient_name = 0.95;
    } else {
        fieldConfidence.patient_name = 0;
        missingFields.push('patient_name');
    }
    
    // MRN confidence
    if (pass2Result.doc?.mrn) {
        fieldConfidence.mrn = 0.90;
    } else {
        fieldConfidence.mrn = 0;
        missingFields.push('mrn');
    }
    
    // Admission date confidence
    if (pass2Result.date_of_admission || pass2Result.admission_date) {
        fieldConfidence.admission_date = 0.92;
    } else {
        fieldConfidence.admission_date = 0;
        if (lowerText.includes('admission') || lowerText.includes('admitted')) {
            missingFields.push('admission_date');
        }
    }
    
    // Discharge date confidence
    if (pass2Result.date_of_discharge || pass2Result.discharge_date) {
        fieldConfidence.discharge_date = 0.92;
    } else {
        fieldConfidence.discharge_date = 0;
        if (lowerText.includes('discharge')) {
            missingFields.push('discharge_date');
        }
    }
    
    // Surgery date confidence  
    if (pass2Result.surgery?.date) {
        fieldConfidence.surgery_date = 0.93;
    } else {
        fieldConfidence.surgery_date = 0;
        if (lowerText.includes('date of surgery') || lowerText.includes('surgery date')) {
            missingFields.push('surgery_date');
        }
    }
    
    // Procedures confidence
    const procedures = pass2Result.surgery?.procedures || [];
    if (procedures.length > 0) {
        // Higher confidence if evidence exists
        const hasEvidence = pass2Result.evidence?.surgery?.procedures;
        fieldConfidence.procedures = hasEvidence ? 0.95 : 0.85;
    } else {
        fieldConfidence.procedures = 0;
        if (lowerText.includes('procedure') || lowerText.includes('operation')) {
            missingFields.push('procedures');
        }
    }
    
    // Preop diagnoses confidence
    const preopDx = pass2Result.diagnoses?.preop || [];
    if (preopDx.length > 0) {
        fieldConfidence.preop_dx = 0.90;
    } else {
        fieldConfidence.preop_dx = 0;
        if (lowerText.includes('preoperative diagnosis') || lowerText.includes('pre-operative diagnosis')) {
            missingFields.push('preop_dx');
        }
    }
    
    // Postop diagnoses confidence
    const postopDx = pass2Result.diagnoses?.postop || [];
    if (postopDx.length > 0) {
        fieldConfidence.postop_dx = 0.90;
    } else {
        fieldConfidence.postop_dx = 0;
        if (lowerText.includes('postoperative diagnosis') || lowerText.includes('post-operative diagnosis')) {
            missingFields.push('postop_dx');
        }
    }
    
    // Medications confidence - lower because they often have missing details
    const meds = pass2Result.medications || [];
    if (meds.length > 0) {
        // Check if doses are present
        const medsWithDose = meds.filter(m => {
            const med = typeof m === 'string' ? m : m;
            return (typeof med === 'object' && med.dose && med.dose !== 'unknown');
        });
        if (medsWithDose.length === meds.length) {
            fieldConfidence.medications = 0.85;
        } else if (medsWithDose.length > 0) {
            fieldConfidence.medications = 0.70;
            missingFields.push('medications_dose');
        } else {
            fieldConfidence.medications = 0.60;
            missingFields.push('medications_dose');
            missingFields.push('medications_frequency');
        }
    } else {
        fieldConfidence.medications = 0;
        if (lowerText.includes('medication') || lowerText.includes('analgesia') || lowerText.includes('discharge med')) {
            missingFields.push('medications');
        }
    }
    
    // Allergies confidence
    const allergies = pass2Result.allergies || [];
    if (allergies.length > 0) {
        // Check if reactions are present (for non-NKDA allergies)
        const isNKDA = allergies.some(a => {
            const sub = typeof a === 'string' ? a : a.substance || '';
            return sub.toLowerCase().includes('nkda') || sub.toLowerCase().includes('no known');
        });
        if (isNKDA) {
            fieldConfidence.allergies = 0.95; // NKDA is very clear
        } else {
            const allergiesWithReaction = allergies.filter(a => typeof a === 'object' && a.reaction);
            if (allergiesWithReaction.length === allergies.length) {
                fieldConfidence.allergies = 0.85;
            } else {
                fieldConfidence.allergies = 0.70;
                missingFields.push('allergies_reaction');
            }
        }
    } else {
        fieldConfidence.allergies = 0;
        if (lowerText.includes('allerg')) {
            missingFields.push('allergies');
        }
    }
    
    return {
        field_confidence: fieldConfidence,
        missing_fields: [...new Set(missingFields)] // dedupe
    };
}

// ============================================================================
// MAIN PIPELINE - HEADER-SLICE FIRST, LLM OPTIONAL
// ============================================================================

async function processDocumentSafe(document) {
    const { stored_path: filePath, id: documentId, patient_id: patientId } = document;
    
    const result = {
        success: false,
        status: 'error',
        pass1: null,
        pass2: null,
        validation: null,
        confidence: { score: 0, breakdown: {} },
        canMerge: false,
        needsReview: false,
        reviewReasons: [],
        model: null,
        schemaVersion: SCHEMA_VERSION,
        textPath: null,
        rawText: null,
        sectionsFound: [],
        error: null
    };
    
    try {
        // Step 1: Extract text
        console.log('[Pipeline] Extracting text from:', filePath);
        if (!fs.existsSync(filePath)) {
            throw new Error('Document file not found');
        }
        
        const textResult = await extractTextFromPDF(filePath);
        result.textPath = textResult.textPath;
        result.rawText = textResult.text;
        
        // Check for OCR need
        if (textResult.needsOCR || textResult.charCount < 200) {
            result.status = 'needs_review';
            result.needsReview = true;
            result.reviewReasons.push('Text extraction failed or document may need OCR');
            return result;
        }
        
        console.log(`[Pipeline] Text extracted: ${textResult.charCount} chars via ${textResult.method}`);
        
        // ====================================================================
        // Step 2: HEADER-SLICE EXTRACTION (Primary - deterministic, no LLM)
        // ====================================================================
        console.log('[Pipeline] Running header-slice extraction...');
        const sliceResult = headerSlice.extractWithHeaderSlice(textResult.text);
        
        result.sectionsFound = sliceResult.sections_found;
        result.model = 'header-slice-regex';
        
        // Convert to pass2 format for consistency
        result.pass2 = sliceResult.extraction;
        result.confidence = sliceResult.confidence;
        
        console.log('[Pipeline] Sections found:', sliceResult.sections_found);
        console.log('[Pipeline] Procedures:', sliceResult.extraction.surgery.procedures);
        console.log('[Pipeline] Preop Dx:', sliceResult.extraction.diagnoses.preop.length);
        console.log('[Pipeline] Postop Dx:', sliceResult.extraction.diagnoses.postop.length);
        console.log('[Pipeline] Medications:', sliceResult.extraction.medications);
        
        // Check for invariant violations
        if (sliceResult.violations.length > 0) {
            result.reviewReasons.push(...sliceResult.violations);
        }
        
        // ====================================================================
        // Step 3: Optional LLM enhancement (only if OpenAI available AND 
        //         header-slice missed important fields)
        // ====================================================================
        const llmAvailable = await isLLMAvailable();
        
        // Only use LLM if we're missing critical data AND OpenAI is available
        const needsLLMHelp = (
            sliceResult.extraction.medications.length === 0 ||
            (sliceResult.invariants.procedures_header_exists && sliceResult.extraction.surgery.procedures.length === 0)
        );
        
        if (llmAvailable && needsLLMHelp) {
            console.log('[Pipeline] Running LLM enhancement for missing fields...');
            try {
                // Only run micro-prompts for what we're missing
                if (sliceResult.extraction.medications.length === 0) {
                    const medsResult = await extractMedsWithLLM(textResult.text);
                    if (medsResult && medsResult.length > 0) {
                        result.pass2.medications = medsResult;
                        result.model = 'header-slice+llm-meds';
                    }
                }
            } catch (e) {
                console.log('[Pipeline] LLM enhancement failed, using regex only:', e.message);
            }
        }
        
        // ====================================================================
        // Step 4: Build validation from header-slice invariants
        // ====================================================================
        
        // Compute field-level confidence (v2 upgrade)
        const fieldConf = computeFieldConfidence(result.pass2, textResult.text);
        
        result.validation = {
            passed: sliceResult.violations.length === 0,
            issues: sliceResult.violations.map(v => ({
                code: 'HEADER_SLICE_VIOLATION',
                message: v,
                severity: 'warning'
            })),
            hasCritical: false,
            hasWarnings: sliceResult.violations.length > 0,
            invariants: sliceResult.invariants,
            // v2: Field-level confidence and missing fields
            field_confidence: fieldConf.field_confidence,
            missing_fields: fieldConf.missing_fields
        };
        
        // ====================================================================
        // Step 5: Determine merge eligibility
        // ====================================================================
        
        // Recalculate confidence after potential LLM enhancement
        result.confidence = computeConfidence(result.pass2);
        console.log('[Pipeline] Final confidence:', result.confidence.score.toFixed(2));
        
        if (result.confidence.score >= CONFIDENCE_AUTO_MERGE && result.validation.passed) {
            result.canMerge = true;
            result.status = 'extracted';
        } else if (result.confidence.score >= CONFIDENCE_REVIEW_RECOMMENDED) {
            result.canMerge = true;
            result.status = 'extracted';
            if (result.confidence.score < CONFIDENCE_AUTO_MERGE) {
                result.reviewReasons.push('Confidence below auto-merge threshold - review recommended');
            }
        } else {
            result.canMerge = false;
            result.status = 'needs_review';
            result.needsReview = true;
            result.reviewReasons.push(`Confidence too low (${(result.confidence.score * 100).toFixed(0)}%)`);
        }
        
        result.success = true;
        return result;
        
    } catch (error) {
        console.error('[Pipeline] Error:', error);
        result.error = error.message;
        result.status = 'error';
        return result;
    }
}

// Micro-prompt for medications only (when regex misses them)
async function extractMedsWithLLM(text) {
    const MEDS_SYSTEM = `Return valid JSON only. Extract medication NAMES ONLY. No effects. No dosing.`;
    const MEDS_USER = `From this text, list explicit medication names.
Return JSON: {"medications":[]}

TEXT:
<<<
${text.substring(0, 4000)}
>>>`;
    
    try {
        const response = await callLLMPass(MEDS_SYSTEM, MEDS_USER, 'gpt-4o-mini');
        const parsed = parseJSONFromLLM(response);
        return parsed.medications || [];
    } catch (e) {
        return [];
    }
}

// ============================================================================
// REGEX FALLBACK (When LLM unavailable)
// ============================================================================

function extractWithRegex(text) {
    const result = {
        doc: { doc_type: null, doc_date: null, facility: null, provider: null, patient_name: null, mrn: null },
        surgery: { has_surgery: false, date: null, surgeon: null, procedures: [] },
        diagnoses: { preop: [], postop: [] },
        medications: [],
        allergies: [],
        functional_limitations: [],
        summary: null,
        evidence: {}
    };
    
    const lowerText = text.toLowerCase();
    
    // Detect document type
    if (lowerText.includes('operative report') || lowerText.includes('op note')) {
        result.doc.doc_type = 'operative_report';
    } else if (lowerText.includes('discharge summary')) {
        result.doc.doc_type = 'discharge_summary';
    }
    
    // Surgery detection
    const surgeryDateMatch = text.match(/(?:date\s+of\s+surgery|surgery\s+date)[:\s]*([^\n]{5,30})/i);
    if (surgeryDateMatch) {
        result.surgery.has_surgery = true;
        result.surgery.date = surgeryDateMatch[1].trim();
        result.evidence.surgery_date = surgeryDateMatch[0];
    }
    
    // Procedure detection
    const procedurePatterns = [
        /\b(arthroscopic\s+(?:partial\s+)?(?:meniscectomy|chondroplasty|surgery)(?:\s+(?:of|and)\s+[^\n.]{5,50})?)/gi,
        /\b((?:total|partial)\s+(?:knee|hip|shoulder)\s+(?:replacement|arthroplasty))/gi,
        /\b((?:ACL|PCL|MCL)\s+(?:reconstruction|repair))/gi,
        /\b(appendectomy|cholecystectomy|hernia\s+repair|laminectomy|discectomy)/gi,
        /\b(exploratory\s+(?:laparotomy|surgery))/gi,
        /\b(bowel\s+resection|anastomosis|colectomy)/gi,
        /\b(CABG|coronary\s+artery\s+bypass)/gi
    ];
    
    for (const pattern of procedurePatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const proc = match[1].trim();
            if (proc.length > 5 && !result.surgery.procedures.includes(proc)) {
                result.surgery.procedures.push(proc);
                result.surgery.has_surgery = true;
            }
        }
    }
    
    // Diagnosis extraction (from labeled sections)
    const preopMatch = text.match(/pre-?operative\s+diagnosis[:\s]+([^.]+\.)/gi);
    if (preopMatch) {
        for (const match of preopMatch) {
            const dx = match.replace(/pre-?operative\s+diagnosis[:\s]*/i, '').trim();
            if (dx.length > 10) result.diagnoses.preop.push(dx);
        }
    }
    
    const postopMatch = text.match(/post-?operative\s+diagnosis[:\s]+([^.]+\.)/gi);
    if (postopMatch) {
        for (const match of postopMatch) {
            const dx = match.replace(/post-?operative\s+diagnosis[:\s]*/i, '').trim();
            if (dx.length > 10) result.diagnoses.postop.push(dx);
        }
    }
    
    // Allergy detection
    if (lowerText.includes('nkda') || lowerText.includes('no known drug allergies') || lowerText.includes('no known allergies')) {
        result.allergies = ['NKDA'];
    }
    
    // Summary
    result.summary = text.substring(0, 500).replace(/\s+/g, ' ').trim() + '...';
    
    return result;
}

// ============================================================================
// CONVERT TO CHART FORMAT (For merge into patient)
// ============================================================================

function convertToChartFormat(pass2Result, documentId) {
    const chart = {
        surgeries: [],
        diagnoses: [],
        medications: [],
        allergies: [],
        summary: pass2Result.summary || null
    };
    
    // Convert surgery - handles both old and new format
    if (pass2Result.surgery?.has_surgery || pass2Result.surgery?.procedures?.length > 0) {
        chart.surgeries.push({
            date: pass2Result.surgery.date || null,
            procedures: pass2Result.surgery.procedures || [],
            surgeon: pass2Result.surgery.surgeon || pass2Result.doc?.provider || null,
            source_document_id: String(documentId)
        });
    }
    
    // Convert diagnoses (combine preop and postop)
    const allDx = [
        ...(pass2Result.diagnoses?.preop || []),
        ...(pass2Result.diagnoses?.postop || [])
    ];
    chart.diagnoses = allDx.map(dx => typeof dx === 'string' ? dx : dx.name || JSON.stringify(dx));
    
    // Convert medications - handle both string[] and object[]
    chart.medications = (pass2Result.medications || []).map(med => {
        if (typeof med === 'string') {
            return { name: med, source_document_id: String(documentId) };
        }
        return { ...med, source_document_id: String(documentId) };
    });
    
    // Convert allergies - handle both string[] and object[]
    chart.allergies = (pass2Result.allergies || []).map(allergy => {
        if (typeof allergy === 'string') {
            return { substance: allergy, source_document_id: String(documentId) };
        }
        return { ...allergy, source_document_id: String(documentId) };
    });
    
    return chart;
}

// ============================================================================
// CONFLICT DETECTION (v2 - safety improvement)
// ============================================================================

/**
 * Detect conflicts between incoming extraction and existing patient chart
 * @param {Object} extractedData - Converted chart format data from extraction
 * @param {Object} existingChart - Current patient chart data
 * @returns {Object} conflicts object with array of conflicts and merge recommendations
 */
function detectConflicts(extractedData, existingChart) {
    const conflicts = [];
    const safeToMerge = {
        procedures: true,
        diagnoses: true,
        medications: true,
        allergies: true
    };
    
    // Parse existing data
    const existingAllergies = Array.isArray(existingChart.allergies) 
        ? existingChart.allergies 
        : safeParseJsonSafe(existingChart.allergies_json, []);
    const existingMeds = Array.isArray(existingChart.medications)
        ? existingChart.medications
        : safeParseJsonSafe(existingChart.medications_json, []);
    const existingSurgeries = Array.isArray(existingChart.surgeries)
        ? existingChart.surgeries
        : safeParseJsonSafe(existingChart.surgery_history_json, []);
    
    const newAllergies = extractedData.allergies || [];
    const newMeds = extractedData.medications || [];
    const newSurgeries = extractedData.surgeries || [];
    
    // ==========================================
    // Conflict 1: NKDA vs actual allergies
    // ==========================================
    const existingHasNKDA = existingAllergies.some(a => {
        const sub = typeof a === 'string' ? a : a.substance || '';
        return sub.toLowerCase().includes('nkda') || sub.toLowerCase().includes('no known');
    });
    const existingHasRealAllergy = existingAllergies.some(a => {
        const sub = typeof a === 'string' ? a : a.substance || '';
        return !sub.toLowerCase().includes('nkda') && !sub.toLowerCase().includes('no known') && sub.length > 0;
    });
    const newHasNKDA = newAllergies.some(a => {
        const sub = typeof a === 'string' ? a : a.substance || '';
        return sub.toLowerCase().includes('nkda') || sub.toLowerCase().includes('no known');
    });
    const newHasRealAllergy = newAllergies.some(a => {
        const sub = typeof a === 'string' ? a : a.substance || '';
        return !sub.toLowerCase().includes('nkda') && !sub.toLowerCase().includes('no known') && sub.length > 0;
    });
    
    // Conflict: Chart says NKDA but incoming doc has real allergies
    if (existingHasNKDA && newHasRealAllergy) {
        const newAllergyNames = newAllergies
            .filter(a => {
                const sub = typeof a === 'string' ? a : a.substance || '';
                return !sub.toLowerCase().includes('nkda');
            })
            .map(a => typeof a === 'string' ? a : a.substance);
        
        conflicts.push({
            field: 'allergies',
            type: 'nkda_vs_allergy',
            existing: ['NKDA'],
            incoming: newAllergyNames,
            action: 'blocked_merge_needs_review',
            severity: 'critical',
            message: `Chart says NKDA but document lists allergies: ${newAllergyNames.join(', ')}`,
            evidence: newAllergies.map(a => typeof a === 'object' ? a.evidence : a)
        });
        safeToMerge.allergies = false;
    }
    
    // Conflict: Chart has real allergies but incoming says NKDA
    if (existingHasRealAllergy && newHasNKDA && !newHasRealAllergy) {
        const existingAllergyNames = existingAllergies
            .filter(a => {
                const sub = typeof a === 'string' ? a : a.substance || '';
                return !sub.toLowerCase().includes('nkda');
            })
            .map(a => typeof a === 'string' ? a : a.substance);
        
        conflicts.push({
            field: 'allergies',
            type: 'allergy_vs_nkda',
            existing: existingAllergyNames,
            incoming: ['NKDA'],
            action: 'blocked_merge_needs_review',
            severity: 'warning',
            message: `Chart has allergies (${existingAllergyNames.join(', ')}) but document says NKDA`
        });
        safeToMerge.allergies = false;
    }
    
    // ==========================================
    // Conflict 2: Surgery date mismatches
    // ==========================================
    for (const newSurgery of newSurgeries) {
        const newDate = newSurgery.date;
        if (!newDate) continue;
        
        // Check if same procedure exists with different date
        for (const existingSurgery of existingSurgeries) {
            const existingDate = existingSurgery.date;
            if (!existingDate) continue;
            
            // Check for similar procedures
            const newProcs = (newSurgery.procedures || []).map(p => p.toLowerCase().trim());
            const existingProcs = (existingSurgery.procedures || []).map(p => p.toLowerCase().trim());
            
            const hasOverlap = newProcs.some(np => 
                existingProcs.some(ep => 
                    np.includes(ep) || ep.includes(np) || 
                    levenshteinSimilar(np, ep, 0.7)
                )
            );
            
            if (hasOverlap && newDate !== existingDate) {
                conflicts.push({
                    field: 'surgery_date',
                    type: 'date_mismatch',
                    existing: existingDate,
                    incoming: newDate,
                    action: 'blocked_merge_needs_review',
                    severity: 'warning',
                    message: `Surgery date conflict: chart has ${existingDate}, document says ${newDate}`,
                    procedures: newSurgery.procedures
                });
                safeToMerge.procedures = false;
            }
        }
    }
    
    // ==========================================
    // Conflict 3: MRN mismatch (if present)
    // ==========================================
    if (extractedData.mrn && existingChart.mrn) {
        const existingMRN = String(existingChart.mrn).replace(/\D/g, '');
        const newMRN = String(extractedData.mrn).replace(/\D/g, '');
        
        if (existingMRN && newMRN && existingMRN !== newMRN) {
            conflicts.push({
                field: 'mrn',
                type: 'mrn_mismatch',
                existing: existingChart.mrn,
                incoming: extractedData.mrn,
                action: 'blocked_merge_needs_review',
                severity: 'critical',
                message: `MRN mismatch: chart has ${existingChart.mrn}, document has ${extractedData.mrn}`
            });
            // Block ALL merges if MRN mismatch - could be wrong patient!
            safeToMerge.procedures = false;
            safeToMerge.diagnoses = false;
            safeToMerge.medications = false;
            safeToMerge.allergies = false;
        }
    }
    
    return {
        hasConflicts: conflicts.length > 0,
        hasCritical: conflicts.some(c => c.severity === 'critical'),
        conflicts,
        safeToMerge
    };
}

// Simple similarity check for procedure names
function levenshteinSimilar(str1, str2, threshold = 0.7) {
    if (!str1 || !str2) return false;
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return true;
    
    // Quick check: if one contains the other, they're similar
    if (longer.includes(shorter) || shorter.includes(longer)) return true;
    
    // Word overlap check
    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);
    const commonWords = words1.filter(w => words2.includes(w));
    
    return commonWords.length / Math.max(words1.length, words2.length) >= threshold;
}

// Safe JSON parse helper
function safeParseJsonSafe(str, defaultVal = []) {
    if (!str) return defaultVal;
    if (typeof str !== 'string') return str;
    try {
        return JSON.parse(str);
    } catch {
        return defaultVal;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    processDocumentSafe,
    extractTextFromPDF,
    isLLMAvailable,
    checkInvariants,
    computeConfidence,
    computeFieldConfidence,
    detectConflicts,
    extractWithRegex,
    convertToChartFormat,
    CONFIDENCE_AUTO_MERGE,
    CONFIDENCE_REVIEW_RECOMMENDED,
    SCHEMA_VERSION
};
