const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Extraction schema for the LLM - focused on surgeries and progressive chart building
const EXTRACTION_SCHEMA = {
    doc: {
        doc_type: null,  // "discharge summary", "op note", "progress note", "imaging report", "lab report"
        doc_date: null,
        facility: null,
        provider: null
    },
    surgeries: [
        // { procedure: null, date: null, laterality: null, surgeon: null, notes: null }
    ],
    diagnoses: [],
    problem_list: [],
    medications: [
        // { name: null, dose: null, frequency: null, route: null }
    ],
    allergies: [
        // { substance: null, reaction: null }
    ],
    vitals: { bp: null, hr: null, temp: null, spo2: null, weight: null },
    labs: [],
    imaging: [],
    key_findings: [],
    summary: null,
    confidence: 0.0,
    notes: []
};

// LLM System prompt
const SYSTEM_PROMPT = `You extract structured medical information from hospital documents. Focus especially on surgeries, procedures, diagnoses, medications, and allergies. Output valid JSON only. No commentary.`;

// LLM User prompt template - focused on surgery extraction
const getUserPrompt = (documentText) => `Extract structured medical data from this hospital document. Pay special attention to:
- Surgeries and procedures (with dates if available)
- Diagnoses and problem list
- Medications
- Allergies

Rules:
- Output valid JSON only, no explanation text.
- Use exactly the keys in the schema provided.
- If a field is not present, use null or [].
- Do not invent facts. Only extract what's explicitly stated.
- If unsure, leave null and add a note in notes[].
- confidence: 0.0 to 1.0 based on how complete/clear the source is.
- For surgeries: {"procedure":string, "date":string|null, "laterality":string|null, "surgeon":string|null, "notes":string|null}
- For medications: {"name":string, "dose":string|null, "frequency":string|null, "route":string|null}
- For allergies: {"substance":string, "reaction":string|null}
- doc_type should be one of: "discharge summary", "op note", "progress note", "imaging report", "lab report", "consult note", "other"

SCHEMA:
${JSON.stringify(EXTRACTION_SCHEMA, null, 2)}

DOCUMENT TEXT:
<<<
${documentText}
>>>`;

/**
 * Extract text from a PDF file
 * Uses pdftotext if available, falls back to basic extraction
 */
async function extractTextFromPDF(pdfPath) {
    const textPath = pdfPath.replace(/\.pdf$/i, '.txt');
    
    try {
        // Try pdftotext first (poppler-utils)
        await execPromise(`pdftotext -layout "${pdfPath}" "${textPath}"`);
        const text = fs.readFileSync(textPath, 'utf-8');
        if (text.trim().length > 100) {
            return { text, textPath, method: 'pdftotext' };
        }
    } catch (e) {
        console.log('pdftotext not available or failed, trying alternative...');
    }
    
    try {
        // Try using pdf-parse library if installed
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(pdfPath);
        const data = await pdfParse(dataBuffer);
        if (data.text && data.text.trim().length > 50) {
            fs.writeFileSync(textPath, data.text);
            return { text: data.text, textPath, method: 'pdf-parse' };
        }
    } catch (e) {
        console.log('pdf-parse not available or failed');
    }
    
    // If text is empty/short, might be a scanned PDF - try OCR
    return await runOCR(pdfPath, textPath);
}

/**
 * Run OCR on a scanned PDF or image
 */
async function runOCR(filePath, textPath) {
    try {
        // Try ocrmypdf first (best for scanned PDFs)
        if (filePath.toLowerCase().endsWith('.pdf')) {
            const ocrPdfPath = filePath.replace(/\.pdf$/i, '_ocr.pdf');
            await execPromise(`ocrmypdf --skip-text "${filePath}" "${ocrPdfPath}"`);
            await execPromise(`pdftotext -layout "${ocrPdfPath}" "${textPath}"`);
            const text = fs.readFileSync(textPath, 'utf-8');
            if (text.trim().length > 50) {
                return { text, textPath, method: 'ocrmypdf' };
            }
        }
    } catch (e) {
        console.log('ocrmypdf not available, trying tesseract...');
    }
    
    try {
        // Fall back to tesseract directly
        await execPromise(`tesseract "${filePath}" "${textPath.replace('.txt', '')}" -l eng`);
        const text = fs.readFileSync(textPath, 'utf-8');
        return { text, textPath, method: 'tesseract' };
    } catch (e) {
        console.log('tesseract failed:', e.message);
    }
    
    // Last resort: return empty with note
    return { 
        text: '[OCR tools not available. Install poppler-utils, ocrmypdf, or tesseract]', 
        textPath: null, 
        method: 'none' 
    };
}

/**
 * Check if Ollama is available
 */
async function isOllamaAvailable() {
    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${OLLAMA_URL}/api/tags`, { 
            signal: controller.signal 
        });
        clearTimeout(timeout);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Call Ollama API for LLM extraction
 */
async function callOllama(documentText, model = 'qwen2.5:7b-instruct') {
    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    
    try {
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: getUserPrompt(documentText),
                system: SYSTEM_PROMPT,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 4096
                }
            })
        });
        
        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}`);
        }
        
        const data = await response.json();
        return { response: data.response, model };
    } catch (error) {
        console.error('Ollama error:', error.message);
        // Try fallback model
        if (model !== 'llama3.2:3b') {
            console.log('Trying fallback model llama3.2:3b...');
            return callOllama(documentText, 'llama3.2:3b');
        }
        throw error;
    }
}

/**
 * Parse and validate LLM JSON output
 */
function parseAndValidateLLMOutput(llmResponse) {
    // Try to extract JSON from the response
    let jsonStr = llmResponse;
    
    // Remove markdown code blocks if present
    const jsonMatch = llmResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1];
    }
    
    // Try to find JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }
    
    try {
        const parsed = JSON.parse(jsonStr);
        
        // Merge with schema to ensure all keys exist
        const result = JSON.parse(JSON.stringify(EXTRACTION_SCHEMA));
        
        // Copy over extracted values - new schema
        if (parsed.doc) Object.assign(result.doc, parsed.doc);
        if (parsed.vitals) Object.assign(result.vitals, parsed.vitals);
        if (Array.isArray(parsed.surgeries)) result.surgeries = parsed.surgeries;
        if (Array.isArray(parsed.problem_list)) result.problem_list = parsed.problem_list;
        if (Array.isArray(parsed.diagnoses)) result.diagnoses = parsed.diagnoses;
        if (Array.isArray(parsed.medications)) result.medications = parsed.medications;
        if (Array.isArray(parsed.allergies)) result.allergies = parsed.allergies;
        if (Array.isArray(parsed.labs)) result.labs = parsed.labs;
        if (Array.isArray(parsed.imaging)) result.imaging = parsed.imaging;
        if (Array.isArray(parsed.key_findings)) result.key_findings = parsed.key_findings;
        if (Array.isArray(parsed.notes)) result.notes = parsed.notes;
        if (parsed.summary) result.summary = parsed.summary;
        if (typeof parsed.confidence === 'number') result.confidence = Math.min(1, Math.max(0, parsed.confidence));
        
        return result;
    } catch (e) {
        console.error('Failed to parse LLM output:', e.message);
        // Return schema with error note
        const result = JSON.parse(JSON.stringify(EXTRACTION_SCHEMA));
        result.notes = ['Failed to parse LLM output: ' + e.message];
        result.confidence = 0;
        return result;
    }
}

/**
 * Main processing pipeline
 */
async function processDocument(document) {
    const { stored_path: filePath } = document;
    
    if (!fs.existsSync(filePath)) {
        throw new Error('Document file not found');
    }
    
    // Step 1: Extract text
    console.log('Extracting text from:', filePath);
    const { text, textPath, method } = await extractTextFromPDF(filePath);
    console.log(`Text extracted using ${method}, length: ${text.length} chars`);
    
    if (text.length < 50) {
        throw new Error('Could not extract sufficient text from document. Is it a valid PDF?');
    }
    
    // Step 2: Check if Ollama is available
    const ollamaAvailable = await isOllamaAvailable();
    
    if (!ollamaAvailable) {
        console.log('Ollama not available, using smart regex fallback...');
        return processDocumentWithRegex(text, textPath, method);
    }
    
    // Step 3: Chunk if needed (for very long documents)
    let processedText = text;
    if (text.length > 15000) {
        // Take first and last portions for context
        processedText = text.substring(0, 10000) + '\n\n[...middle content omitted...]\n\n' + text.substring(text.length - 5000);
    }
    
    // Step 4: Call LLM
    console.log('Calling Ollama for extraction...');
    try {
        const { response: llmResponse, model } = await callOllama(processedText);
        console.log('LLM response received');
        
        // Step 5: Parse and validate
        const extracted = parseAndValidateLLMOutput(llmResponse);
        extracted.notes = extracted.notes || [];
        extracted.notes.push(`Extracted using ${method} + ${model}`);
        
        return {
            extracted,
            textPath,
            model,
            rawText: text
        };
    } catch (llmError) {
        console.log('LLM extraction failed, using smart regex fallback:', llmError.message);
        return processDocumentWithRegex(text, textPath, method);
    }
}

/**
 * Smart regex-based extraction (fallback when LLM unavailable)
 * Focuses on surgeries, diagnoses, medications, allergies
 */
function processDocumentWithRegex(text, textPath, method) {
    const result = JSON.parse(JSON.stringify(EXTRACTION_SCHEMA));
    const lowerText = text.toLowerCase();
    
    // === SURGERY / PROCEDURE DETECTION ===
    // Only match actual procedure names, not random text after "Procedure:"
    const surgeryTermPatterns = [
        // Specific orthopedic procedures
        /\b(arthroscopic\s+(?:partial\s+)?(?:meniscectomy|chondroplasty|debridement|surgery)(?:\s+(?:of|and)\s+(?:the\s+)?(?:right|left)?\s*(?:knee|hip|shoulder|ankle))?)/gi,
        /\b((?:total|partial)\s+(?:knee|hip|shoulder)\s+(?:replacement|arthroplasty))/gi,
        /\b((?:ACL|PCL|MCL|LCL)\s+(?:reconstruction|repair|surgery))/gi,
        /\b((?:meniscus|meniscal|labrum|labral)\s+(?:repair|resection|debridement))/gi,
        /\b(rotator\s+cuff\s+(?:repair|surgery|reconstruction))/gi,
        /\b((?:knee|hip|shoulder)\s+arthroscopy)/gi,
        
        // General surgery procedures (specific names ending in -ectomy, -plasty, -otomy)
        /\b(appendectomy|cholecystectomy|hernia\s+repair|splenectomy|thyroidectomy)/gi,
        /\b(colectomy|gastrectomy|nephrectomy|prostatectomy|cystectomy)/gi,
        /\b(mastectomy|lumpectomy|hysterectomy|oophorectomy)/gi,
        /\b(c-section|cesarean\s+section|cesarean\s+delivery)/gi,
        
        // Cardiac
        /\b(CABG|coronary\s+artery\s+bypass(?:\s+graft(?:ing)?)?)/gi,
        /\b(angioplasty|stent\s+placement|cardiac\s+catheterization)/gi,
        /\b(valve\s+(?:replacement|repair))/gi,
        
        // Spine
        /\b(laminectomy|discectomy|spinal\s+fusion|vertebroplasty|kyphoplasty)/gi,
        /\b((?:cervical|lumbar|thoracic)\s+(?:fusion|decompression))/gi,
        
        // Other common
        /\b(carpal\s+tunnel\s+release)/gi,
        /\b(cataract\s+(?:surgery|removal|extraction))/gi,
        /\b(tonsillectomy|adenoidectomy)/gi
    ];
    
    const foundSurgeries = new Set();
    for (const pattern of surgeryTermPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            let proc = match[1].trim().replace(/\s+/g, ' ');
            // Capitalize properly
            proc = proc.charAt(0).toUpperCase() + proc.slice(1).toLowerCase();
            if (proc.length > 5 && proc.length < 80) {
                foundSurgeries.add(proc);
            }
        }
    }
    
    // Find surgery date from document
    const datePattern = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi;
    
    // Look for surgery date specifically
    const surgeryDateMatch = text.match(/(?:date\s+of\s+surgery|surgery\s+date|procedure\s+date)[:\s]*([^\n]{5,30})/i);
    let surgeryDate = null;
    if (surgeryDateMatch) {
        const dateInMatch = surgeryDateMatch[1].match(datePattern);
        if (dateInMatch) surgeryDate = dateInMatch[0];
    }
    
    // Fallback to first date in document
    if (!surgeryDate) {
        const documentDates = text.match(datePattern) || [];
        surgeryDate = documentDates[0] || null;
    }
    for (const surgery of foundSurgeries) {
        result.surgeries.push({
            procedure: surgery,
            date: surgeryDate,
            notes: 'Extracted via pattern matching'
        });
    }
    
    // === DIAGNOSIS DETECTION ===
    // Look for diagnosis sections - capture text until period or newline
    const diagnosisSectionMatch = text.match(/(?:pre-?operative\s+diagnosis|post-?operative\s+diagnosis)[:\s]+([^\.]+\.)/gi);
    const foundDiagnoses = new Set();
    
    if (diagnosisSectionMatch) {
        for (const match of diagnosisSectionMatch) {
            // Remove the "Pre-Operative Diagnosis" / "Post-Operative Diagnosis" prefix
            let diagText = match.replace(/^(?:pre-?operative\s+diagnosis|post-?operative\s+diagnosis)[:\s]*/i, '').trim();
            // Clean up whitespace
            diagText = diagText.replace(/\s+/g, ' ').trim();
            if (diagText.length > 10 && diagText.length < 200) {
                foundDiagnoses.add(diagText);
            }
        }
    }
    
    // Also look for specific condition patterns
    const conditionPatterns = [
        /\b(osteoarthritis(?:\s+of\s+[^\n,\.]{5,30})?)/gi,
        /\b(rheumatoid\s+arthritis)/gi,
        /\b(degenerative\s+(?:joint|disc)\s+disease)/gi,
        /\b((?:medial|lateral)\s+meniscal?\s+tear(?:\s+of\s+[^\n,\.]{5,30})?)/gi,
        /\b((?:ACL|PCL|MCL|LCL)\s+tear)/gi,
        /\b(rotator\s+cuff\s+tear)/gi,
        /\b(diabetes\s+(?:mellitus|type\s+[12I]))/gi,
        /\b(hypertension)/gi,
        /\b((?:coronary\s+artery|heart)\s+disease)/gi,
        /\b(COPD|chronic\s+obstructive\s+pulmonary\s+disease)/gi,
        /\b(CHF|congestive\s+heart\s+failure)/gi
    ];
    
    for (const pattern of conditionPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const diag = match[1].trim().replace(/\s+/g, ' ');
            if (diag.length > 3) {
                foundDiagnoses.add(diag.charAt(0).toUpperCase() + diag.slice(1).toLowerCase());
            }
        }
    }
    result.diagnoses = Array.from(foundDiagnoses);
    
    // === MEDICATION DETECTION ===
    const medPatterns = [
        /(?:medications?|meds|prescribed)[:\s]*([^\n]{5,200})/gi,
        /\b(\w+)\s+(\d+)\s*(?:mg|mcg|ml|units?)\s*(?:daily|bid|tid|qid|prn|qd|qhs)?/gi
    ];
    
    const foundMeds = new Set();
    for (const pattern of medPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            // For the detailed pattern, build med string
            if (match[2]) {
                foundMeds.add(`${match[1]} ${match[2]}mg`);
            } else {
                // Split comma-separated list
                const meds = match[1].split(/[,;]/).map(m => m.trim()).filter(m => m.length > 2);
                meds.forEach(m => foundMeds.add(m));
            }
        }
    }
    result.medications = Array.from(foundMeds).slice(0, 20); // Limit
    
    // === ALLERGY DETECTION ===
    const allergyMatch = text.match(/(?:allergies?|allergic to)[:\s]*([^\n]{3,100})/i);
    if (allergyMatch) {
        const allergies = allergyMatch[1].split(/[,;]/).map(a => a.trim()).filter(a => a.length > 1);
        result.allergies = allergies;
    }
    if (lowerText.includes('nkda') || lowerText.includes('no known drug allergies')) {
        result.allergies = ['NKDA'];
    }
    
    // === DOCUMENT TYPE DETECTION ===
    if (lowerText.includes('operative report') || lowerText.includes('op note')) {
        result.doc.type = 'operative_report';
    } else if (lowerText.includes('discharge summary')) {
        result.doc.type = 'discharge_summary';
    } else if (lowerText.includes('history and physical') || lowerText.includes('h&p')) {
        result.doc.type = 'history_physical';
    } else if (lowerText.includes('consultation') || lowerText.includes('consult note')) {
        result.doc.type = 'consultation';
    } else if (lowerText.includes('radiology') || lowerText.includes('imaging')) {
        result.doc.type = 'imaging_report';
    } else if (lowerText.includes('lab') || lowerText.includes('laboratory')) {
        result.doc.type = 'lab_report';
    }
    
    // Extract document date
    if (surgeryDate) {
        result.doc.date = surgeryDate;
    }
    
    // === SUMMARY ===
    const firstLines = text.substring(0, 500).replace(/\s+/g, ' ').trim();
    result.summary = firstLines + (text.length > 500 ? '...' : '');
    
    // Set confidence based on what we found
    let confidence = 0.3;
    if (result.surgeries.length > 0) confidence += 0.2;
    if (result.diagnoses.length > 0) confidence += 0.15;
    if (result.medications.length > 0) confidence += 0.1;
    if (result.allergies.length > 0) confidence += 0.05;
    result.confidence = Math.min(0.8, confidence);
    
    result.notes = [
        'Extracted via smart pattern matching (Ollama unavailable)',
        `Text extracted using ${method}`,
        'For best results, install Ollama: brew install ollama && ollama pull qwen2.5:7b-instruct'
    ];
    
    return {
        extracted: result,
        textPath,
        model: 'regex-smart-fallback',
        rawText: text
    };
}

/**
 * Alternative: Manual extraction without LLM (for testing)
 * Wraps the regex-based extraction
 */
async function processDocumentManual(document) {
    const { stored_path: filePath } = document;
    const { text, textPath, method } = await extractTextFromPDF(filePath);
    return processDocumentWithRegex(text, textPath, method);
}

module.exports = {
    processDocument,
    processDocumentManual,
    processDocumentWithRegex,
    extractTextFromPDF,
    callOllama,
    isOllamaAvailable,
    EXTRACTION_SCHEMA
};
