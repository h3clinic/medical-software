/**
 * Header-Slice Extractor
 * 
 * Zero-LLM extraction using deterministic header slicing and regex.
 * This reliably extracts diagnoses, procedures, and medications from 
 * medical documents by:
 * 
 * 1. Slicing text into sections by known headers
 * 2. Extracting numbered lists with regex (not LLM)
 * 3. Extracting medications from parentheticals + keyword scan
 * 4. Enforcing hard invariants (header exists → list must not be empty)
 */

// Known medical document headers (order matters for slicing)
const HEADERS = [
    'Preoperative Diagnoses',
    'Preoperative Diagnosis',
    'Pre-Operative Diagnoses',
    'Pre-Operative Diagnosis',
    'Postoperative Diagnoses',
    'Postoperative Diagnosis',
    'Post-Operative Diagnoses',
    'Post-Operative Diagnosis',
    'Procedures Performed',
    'Procedure Performed',
    'Procedures',
    'Anesthesia',
    'Indication for Surgery',
    'Indications for Surgery',
    'Operative Findings',
    'Postoperative Course',
    'Post-Operative Course',
    'Functional Limitations',
    'Discharge Plan',
    'Discharge Instructions',
    'Prognosis',
    'Physician Signature',
    'Attending Physician',
    'Follow-Up',
    'Medications',
    'Current Medications',
    'Allergies',
    'Known Allergies'
];

// Build regex pattern from headers (case-insensitive)
const HEADER_PATTERN = new RegExp(
    `^\\s*(${HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*$`,
    'im'
);

// Pattern to detect ANY header line (for slicing)
const ANY_HEADER_REGEX = new RegExp(
    `^\\s*(${HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*`,
    'i'
);

/**
 * Slice text into sections by header
 * @param {string} text - Full document text
 * @returns {Object} Map of header name → section content
 */
function sliceByHeaders(text) {
    const sections = {};
    const lines = text.split('\n');
    
    let currentHeader = null;
    let currentContent = [];
    
    for (const line of lines) {
        // Check if this line is a header
        let matchedHeader = null;
        for (const header of HEADERS) {
            // Match header at start of line (with possible whitespace/punctuation)
            const headerRegex = new RegExp(`^\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s]*$`, 'i');
            if (headerRegex.test(line) || line.trim().toLowerCase() === header.toLowerCase()) {
                matchedHeader = header;
                break;
            }
        }
        
        if (matchedHeader) {
            // Save previous section
            if (currentHeader) {
                sections[normalizeHeaderKey(currentHeader)] = currentContent.join('\n').trim();
            }
            // Start new section
            currentHeader = matchedHeader;
            currentContent = [];
        } else if (currentHeader) {
            currentContent.push(line);
        }
    }
    
    // Save last section
    if (currentHeader) {
        sections[normalizeHeaderKey(currentHeader)] = currentContent.join('\n').trim();
    }
    
    return sections;
}

/**
 * Normalize header names to consistent keys
 */
function normalizeHeaderKey(header) {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    // Map variations to canonical keys
    if (normalized.includes('preop') && normalized.includes('diagnos')) return 'preop_diagnoses';
    if (normalized.includes('postop') && normalized.includes('diagnos')) return 'postop_diagnoses';
    if (normalized.includes('procedure')) return 'procedures';
    if (normalized.includes('anesthesia')) return 'anesthesia';
    if (normalized.includes('indication')) return 'indication';
    if (normalized.includes('operative_finding')) return 'operative_findings';
    if (normalized.includes('postop') && normalized.includes('course')) return 'postop_course';
    if (normalized.includes('functional')) return 'functional_limitations';
    if (normalized.includes('discharge')) return 'discharge_plan';
    if (normalized.includes('prognosis')) return 'prognosis';
    if (normalized.includes('physician') || normalized.includes('signature')) return 'physician_signature';
    if (normalized.includes('medication')) return 'medications';
    if (normalized.includes('allerg')) return 'allergies';
    
    return normalized;
}

/**
 * Extract numbered list items from a text block
 * Handles:
 * - "1. Item text"
 * - "1) Item text"
 * - "● Item text" (bullets)
 * - Wrapped/continuation lines
 * 
 * @param {string} block - Section text
 * @returns {string[]} Array of list items
 */
function extractNumberedList(block) {
    if (!block || !block.trim()) return [];
    
    const items = [];
    const lines = block.split('\n');
    let currentItem = null;
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Check for numbered item start: "1." or "1)" or "●" or "○" or "-"
        const numberedMatch = trimmed.match(/^(\d+)[.)]\s*(.+)/);
        const bulletMatch = trimmed.match(/^[●○•\-\*]\s*(.+)/);
        
        if (numberedMatch) {
            // Save previous item
            if (currentItem !== null) {
                items.push(currentItem.trim());
            }
            // Start new numbered item
            currentItem = numberedMatch[2];
        } else if (bulletMatch && currentItem === null) {
            // Bullet at top level (not nested)
            items.push(bulletMatch[1].trim());
        } else if (currentItem !== null) {
            // Check if this is a continuation (indented or doesn't look like new content)
            const isIndented = line.startsWith('   ') || line.startsWith('\t');
            const isSubBullet = trimmed.match(/^[○•\-]\s*/);
            
            if (isSubBullet) {
                // Skip sub-bullets, they're details
                continue;
            } else if (isIndented || (!trimmed.match(/^[A-Z]/) && trimmed.length < 60)) {
                // Likely continuation - append to current item
                currentItem += ' ' + trimmed;
            } else {
                // Looks like new content but not numbered - might be end of list
                // Save current and don't continue
                items.push(currentItem.trim());
                currentItem = null;
            }
        }
    }
    
    // Save last item
    if (currentItem !== null) {
        items.push(currentItem.trim());
    }
    
    return items.filter(item => item.length > 0);
}

/**
 * Extract medications using regex (no LLM)
 * 
 * Strategy:
 * 1. Extract from parentheticals containing drug-related keywords
 * 2. Keyword scan for common medication names
 * 3. Look for "medication" section if exists
 * 
 * @param {string} text - Full document or postop course section
 * @returns {string[]} Array of medication names
 */
function extractMedications(text) {
    if (!text) return [];
    
    const meds = new Set();
    
    // Layer A: Extract from parentheticals
    // Pattern: (morphine/hydromorphone) or (drug1, drug2)
    const parenMatches = text.match(/\(([^)]+)\)/g) || [];
    
    for (const match of parenMatches) {
        const inner = match.slice(1, -1); // Remove parens
        
        // Check if this looks like medication (contains drug keywords or known drug names)
        const drugKeywords = /opioid|analgesia|analgesic|pain|antibiotic|antiemetic|sedation/i;
        const knownDrugs = /morphine|hydromorphone|acetaminophen|tylenol|ibuprofen|aspirin|fentanyl|oxycodone|hydrocodone|codeine|tramadol|ketorolac|toradol|ondansetron|zofran|metoclopramide|reglan|diphenhydramine|benadryl|lorazepam|ativan|midazolam|propofol|cefazolin|ancef|vancomycin|piperacillin|metronidazole|flagyl|heparin|enoxaparin|lovenox|warfarin|coumadin|aspirin|clopidogrel|plavix|atorvastatin|lipitor|metformin|lisinopril|amlodipine|omeprazole|pantoprazole|gabapentin|prednisone|albuterol|furosemide|lasix/i;
        
        if (drugKeywords.test(inner) || knownDrugs.test(inner)) {
            // Split by / or , and add each
            const parts = inner.split(/[\/,]/).map(p => p.trim()).filter(p => p.length > 2);
            for (const part of parts) {
                // Clean up - only keep if it looks like a drug name (not a phrase)
                if (part.length < 50 && !part.includes(' the ') && knownDrugs.test(part)) {
                    meds.add(capitalizeFirst(part));
                } else if (knownDrugs.test(part)) {
                    // Extract just the drug name from the phrase
                    const drugMatch = part.match(knownDrugs);
                    if (drugMatch) {
                        meds.add(capitalizeFirst(drugMatch[0]));
                    }
                }
            }
        }
    }
    
    // Layer B: Keyword scan for specific medications mentioned in text
    const medicationPatterns = [
        /\b(morphine)\b/gi,
        /\b(hydromorphone)\b/gi,
        /\b(acetaminophen|tylenol)\b/gi,
        /\b(ibuprofen|advil|motrin)\b/gi,
        /\b(fentanyl)\b/gi,
        /\b(oxycodone|oxycontin|percocet)\b/gi,
        /\b(hydrocodone|vicodin|norco)\b/gi,
        /\b(tramadol|ultram)\b/gi,
        /\b(ketorolac|toradol)\b/gi,
        /\b(ondansetron|zofran)\b/gi,
        /\b(metoclopramide|reglan)\b/gi,
        /\b(cefazolin|ancef)\b/gi,
        /\b(vancomycin)\b/gi,
        /\b(metronidazole|flagyl)\b/gi,
        /\b(heparin)\b/gi,
        /\b(enoxaparin|lovenox)\b/gi,
        /\b(gabapentin|neurontin)\b/gi,
        /\b(prednisone)\b/gi,
        /\b(omeprazole|prilosec)\b/gi,
        /\b(pantoprazole|protonix)\b/gi,
        /\b(furosemide|lasix)\b/gi,
        /\b(lisinopril)\b/gi,
        /\b(metformin)\b/gi,
        /\b(aspirin)\b/gi,
        /\b(warfarin|coumadin)\b/gi,
        /\b(clopidogrel|plavix)\b/gi,
    ];
    
    for (const pattern of medicationPatterns) {
        const matches = text.match(pattern);
        if (matches) {
            for (const match of matches) {
                meds.add(capitalizeFirst(match.toLowerCase()));
            }
        }
    }
    
    // Layer C: Look for "Scheduled [medication]" pattern
    const scheduledMatch = text.match(/scheduled\s+(\w+)/gi);
    if (scheduledMatch) {
        for (const match of scheduledMatch) {
            const drug = match.replace(/scheduled\s+/i, '');
            if (drug.length > 3 && /acetaminophen|ibuprofen|tylenol|aspirin/i.test(drug)) {
                meds.add(capitalizeFirst(drug.toLowerCase()));
            }
        }
    }
    
    return Array.from(meds);
}

/**
 * Extract allergies
 * @param {string} text - Full document text
 * @returns {string[]} Array of allergies
 */
function extractAllergies(text) {
    if (!text) return [];
    
    // Check for NKDA / No known drug allergies
    if (/\bNKDA\b/i.test(text) || /no\s+known\s+(drug\s+)?allergies/i.test(text)) {
        return ['NKDA'];
    }
    
    // Look for allergies section and extract
    const allergySectionMatch = text.match(/allergies[:\s]*\n([\s\S]*?)(?=\n\s*[A-Z][a-z]+\s*:|$)/i);
    if (allergySectionMatch) {
        const items = extractNumberedList(allergySectionMatch[1]);
        if (items.length > 0) return items;
    }
    
    // Look for inline "allergic to X" patterns
    const allergicToMatch = text.match(/allergic\s+to\s+([^.,\n]+)/gi);
    if (allergicToMatch) {
        return allergicToMatch.map(m => m.replace(/allergic\s+to\s+/i, '').trim());
    }
    
    return [];
}

/**
 * Extract surgery metadata
 * @param {string} text - Full document text
 * @returns {Object} Surgery metadata
 */
function extractSurgeryMetadata(text) {
    const metadata = {
        date: null,
        surgeon: null,
        facility: null,
        patient_name: null,
        mrn: null
    };
    
    // Date of Surgery
    const dateMatch = text.match(/date\s+of\s+surgery[:\s]*([^\n]+)/i);
    if (dateMatch) {
        metadata.date = dateMatch[1].trim();
    }
    
    // Surgeon
    const surgeonMatch = text.match(/(?:attending|reporting)\s+(?:surgeon|physician)[:\s]*([^\n]+)/i) ||
                         text.match(/surgeon[:\s]*([^\n]+)/i);
    if (surgeonMatch) {
        metadata.surgeon = surgeonMatch[1].trim().replace(/^Dr\.?\s*/i, 'Dr. ');
    }
    
    // Facility
    const facilityMatch = text.match(/facility[:\s]*([^\n]+)/i) ||
                          text.match(/(?:hospital|medical center|clinic)[:\s]*([^\n]+)/i);
    if (facilityMatch) {
        metadata.facility = facilityMatch[1].trim();
    }
    
    // Patient name
    const nameMatch = text.match(/patient\s+name[:\s]*([^\n]+)/i);
    if (nameMatch) {
        metadata.patient_name = nameMatch[1].trim();
    }
    
    // MRN
    const mrnMatch = text.match(/(?:medical\s+record\s+number|mrn)[:\s()]*([A-Z0-9\-]+)/i);
    if (mrnMatch) {
        metadata.mrn = mrnMatch[1].trim();
    }
    
    return metadata;
}

/**
 * Helper: capitalize first letter
 */
function capitalizeFirst(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Main extraction function using header-slice approach
 * 
 * @param {string} text - Full document text
 * @returns {Object} Extraction result with validation info
 */
function extractWithHeaderSlice(text) {
    // Step 1: Slice into sections
    const sections = sliceByHeaders(text);
    
    console.log('[HeaderSlice] Found sections:', Object.keys(sections));
    
    // Step 2: Extract from each section using regex
    const preopDx = sections.preop_diagnoses ? extractNumberedList(sections.preop_diagnoses) : [];
    const postopDx = sections.postop_diagnoses ? extractNumberedList(sections.postop_diagnoses) : [];
    const procedures = sections.procedures ? extractNumberedList(sections.procedures) : [];
    
    // Step 3: Extract medications from postop course (primary) or full text (fallback)
    const postopCourse = sections.postop_course || '';
    let medications = extractMedications(postopCourse);
    if (medications.length === 0) {
        // Fallback to full text scan
        medications = extractMedications(text);
    }
    
    // Step 4: Extract allergies
    const allergies = extractAllergies(text);
    
    // Step 5: Extract metadata
    const metadata = extractSurgeryMetadata(text);
    
    // Step 6: Extract functional limitations if present
    const functionalLimitations = sections.functional_limitations 
        ? extractNumberedList(sections.functional_limitations) 
        : [];
    
    // Step 7: Build invariants check
    const invariants = {
        preop_diagnoses_header_exists: 'preop_diagnoses' in sections,
        postop_diagnoses_header_exists: 'postop_diagnoses' in sections,
        procedures_header_exists: 'procedures' in sections,
        preop_diagnoses_extracted: preopDx.length > 0,
        postop_diagnoses_extracted: postopDx.length > 0,
        procedures_extracted: procedures.length > 0
    };
    
    // Check for invariant violations
    const violations = [];
    if (invariants.preop_diagnoses_header_exists && !invariants.preop_diagnoses_extracted) {
        violations.push('Preoperative Diagnoses section found but extraction returned empty');
    }
    if (invariants.postop_diagnoses_header_exists && !invariants.postop_diagnoses_extracted) {
        violations.push('Postoperative Diagnoses section found but extraction returned empty');
    }
    if (invariants.procedures_header_exists && !invariants.procedures_extracted) {
        violations.push('Procedures section found but extraction returned empty');
    }
    
    // Build extraction result
    const extraction = {
        doc: {
            doc_type: 'surgical_report',
            doc_date: metadata.date,
            facility: metadata.facility,
            provider: metadata.surgeon,
            patient_name: metadata.patient_name,
            mrn: metadata.mrn
        },
        surgery: {
            has_surgery: procedures.length > 0,
            date: metadata.date,
            surgeon: metadata.surgeon,
            procedures: procedures
        },
        diagnoses: {
            preop: preopDx,
            postop: postopDx
        },
        medications: medications,
        allergies: allergies,
        functional_limitations: functionalLimitations,
        summary: buildSummary(text),
        evidence: {
            surgery_date: metadata.date ? `Date of Surgery: ${metadata.date}` : null,
            procedures_section: sections.procedures ? sections.procedures.substring(0, 200) : null,
            preop_dx_section: sections.preop_diagnoses ? sections.preop_diagnoses.substring(0, 200) : null,
            postop_dx_section: sections.postop_diagnoses ? sections.postop_diagnoses.substring(0, 200) : null
        }
    };
    
    // Compute confidence
    const confidence = computeConfidence(extraction, invariants);
    
    return {
        extraction,
        confidence,
        invariants,
        violations,
        sections_found: Object.keys(sections),
        method: 'header-slice-regex'
    };
}

/**
 * Build a summary from the text
 */
function buildSummary(text) {
    // Take first ~500 chars, clean up
    const preview = text.substring(0, 600).replace(/\s+/g, ' ').trim();
    return preview.length < 600 ? preview : preview + '...';
}

/**
 * Compute confidence score based on extraction completeness
 */
function computeConfidence(extraction, invariants) {
    let score = 0;
    const breakdown = {};
    
    // Surgery date: +0.20
    if (extraction.surgery.date) {
        score += 0.20;
        breakdown.surgery_date = 0.20;
    }
    
    // Procedures: +0.25
    if (extraction.surgery.procedures.length > 0) {
        score += 0.25;
        breakdown.procedures = 0.25;
    }
    
    // Preop diagnoses: +0.15
    if (extraction.diagnoses.preop.length > 0) {
        score += 0.15;
        breakdown.preop_diagnoses = 0.15;
    }
    
    // Postop diagnoses: +0.15
    if (extraction.diagnoses.postop.length > 0) {
        score += 0.15;
        breakdown.postop_diagnoses = 0.15;
    }
    
    // Medications: +0.10
    if (extraction.medications.length > 0) {
        score += 0.10;
        breakdown.medications = 0.10;
    }
    
    // Allergies: +0.05
    if (extraction.allergies.length > 0) {
        score += 0.05;
        breakdown.allergies = 0.05;
    }
    
    // Evidence/metadata: +0.10
    if (extraction.doc.surgeon || extraction.doc.facility) {
        score += 0.10;
        breakdown.metadata = 0.10;
    }
    
    // Penalty for invariant violations
    const violationCount = Object.entries(invariants)
        .filter(([k, v]) => k.includes('_exists') && v && !invariants[k.replace('_exists', '_extracted')])
        .length;
    
    if (violationCount > 0) {
        const penalty = violationCount * 0.15;
        score = Math.max(0, score - penalty);
        breakdown.invariant_penalty = -penalty;
    }
    
    return {
        score: Math.round(score * 100) / 100,
        breakdown
    };
}

/**
 * Convert extraction to chart-compatible format
 */
function convertToChartFormat(extraction, documentId) {
    // Combine preop and postop diagnoses for problem list
    const problems = [
        ...extraction.diagnoses.preop,
        ...extraction.diagnoses.postop
    ];
    
    // Build surgery entry in new format
    const surgeries = [];
    if (extraction.surgery.has_surgery && extraction.surgery.procedures.length > 0) {
        surgeries.push({
            date: extraction.surgery.date,
            procedures: extraction.surgery.procedures,
            surgeon: extraction.surgery.surgeon,
            source_document_id: String(documentId)
        });
    }
    
    // Medications as objects
    const medications = extraction.medications.map(name => ({ name }));
    
    return {
        surgeries,
        problems,
        medications,
        allergies: extraction.allergies,
        summary: extraction.summary
    };
}

module.exports = {
    sliceByHeaders,
    extractNumberedList,
    extractMedications,
    extractAllergies,
    extractSurgeryMetadata,
    extractWithHeaderSlice,
    convertToChartFormat,
    computeConfidence,
    HEADERS
};
