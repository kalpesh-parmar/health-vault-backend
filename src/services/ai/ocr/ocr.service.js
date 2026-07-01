const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const { env } = require("../../../configs/env");
const { ollamaClient } = require("../clients/ollamaClient");
const { NonMedicalDocumentException } = require("../../../exceptions/appError");
const prompts = require("../prompts");
const sharp = require("sharp");

async function preprocessImage(imageBuffer) {
  try {
    console.log(
      "[OcrService] Preprocessing image with Sharp: auto-orient, resize (max 1600px), converting to jpeg",
    );
    const processedBuffer = await sharp(imageBuffer)
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    return processedBuffer;
  } catch (error) {
    console.warn(
      "[OcrService] Image preprocessing failed, falling back to raw buffer:",
      error.message,
    );
    return imageBuffer;
  }
}

// DB dependencies for processAndStoreSynchronously
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { ocrStatus } = require("../../../enums/ocrStatus");
const { fileTypeValue } = require("../../../enums/fileType");
const uploadFileService = require("../../uploadFileService");

const TestResultSchema = z.object({
  testName: z.string().nullable().default(null),
  value: z.string().nullable().or(z.number().nullable()).default(null),
  unit: z.string().nullable().default(null),
  referenceRange: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
});

const MedicationSchema = z.object({
  name: z.string().nullable().default(null),
  dosage: z.string().nullable().default(null),
  frequency: z.string().nullable().default(null),
  duration: z.string().nullable().default(null),
  instructions: z.string().nullable().default(null),
});

const MedicalExtractionSchema = z.object({
  patientName: z.string().nullable().default(null),
  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  age: z.number().nullable().or(z.string().nullable()).default(null),
  gender: z.string().nullable().default(null),
  reportDate: z.string().nullable().default(null),
  visitDate: z.string().nullable().default(null),
  dateOfBirth: z.string().nullable().default(null),
  doctorName: z.string().nullable().default(null),
  hospitalName: z.string().nullable().default(null),
  diagnosis: z.string().nullable().or(z.array(z.string())).default(null),
  medications: z.array(MedicationSchema).default([]),
  testResults: z.array(TestResultSchema).default([]),
  remarks: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phoneNumber: z.string().nullable().default(null),
  bloodGroup: z.string().nullable().default(null),
  allergies: z.array(z.string()).default([]),
  medicalConditions: z.array(z.string()).default([]),
  address: z.string().nullable().default(null),
});

function normalizeDate(dobStr) {
  if (!dobStr) return null;
  const cleaned = String(dobStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }
  const matchDmy = cleaned.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (matchDmy) {
    const day = matchDmy[1].padStart(2, "0");
    const month = matchDmy[2].padStart(2, "0");
    const year = matchDmy[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}

function normalizeGender(genderStr) {
  if (!genderStr) return null;
  const cleaned = String(genderStr).trim().toLowerCase();
  if (cleaned.includes("female") || cleaned === "સ્ત્રી" || cleaned === "stri") {
    return "female";
  }
  if (cleaned.includes("male") || cleaned === "પુરુષ" || cleaned === "purush") {
    return "male";
  }
  return null;
}

function normalizeBloodGroup(bgStr) {
  if (!bgStr) return null;
  const cleaned = String(bgStr).trim().toUpperCase();
  const valid = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
  if (valid.includes(cleaned)) {
    return cleaned;
  }
  return null;
}

function normalizeEmail(emailStr) {
  if (!emailStr) return null;
  const cleaned = String(emailStr).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : null;
}

function normalizePhone(phoneStr) {
  if (!phoneStr) return null;
  const cleaned = String(phoneStr)
    .trim()
    .replace(/[^\d+]/g, "");
  return cleaned.length >= 7 && cleaned.length <= 15 ? cleaned : null;
}

function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
}

// Helper functions for normalization (formerly in medicalExtractionService from aiService)
function pickEntities(entities, type) {
  if (!Array.isArray(entities)) return [];
  return entities.filter((entity) => (entity?.type || "").toLowerCase() === type);
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pickReportDate(normalized) {
  for (const prescription of normalized.prescriptions || []) {
    if (prescription?.issueDate) return prescription.issueDate;
  }
  const dateEntities = pickEntities(normalized.medicalEntities, "date");
  if (dateEntities.length) return dateEntities[0].value || dateEntities[0].name;
  return null;
}

function pickFirstField(rows, field) {
  for (const row of rows || []) {
    if (row?.[field]) return row[field];
  }
  return null;
}

function buildMedications(normalized) {
  const medications = [];

  for (const med of normalized.medications || []) {
    if (!med) continue;
    medications.push({
      dosage: med?.dosage || med?.dose || null,
      duration: med?.duration || null,
      frequency: med?.frequency || null,
      instructions: med?.instructions || med?.notes || null,
      name: med?.name || med?.medicineName || med?.medicationName || null,
      timing: med?.timing || med?.when || null,
    });
  }

  for (const prescription of normalized.prescriptions || []) {
    for (const med of prescription?.medications || []) {
      medications.push({
        dosage: med?.dosage || null,
        duration: med?.duration || null,
        frequency: med?.frequency || null,
        instructions: med?.instructions || null,
        name: med?.name || med?.medicineName || null,
        timing: med?.timing || null,
      });
    }
  }

  return medications.filter((m) => m.name);
}

function buildLabResults(normalized) {
  const labRows = [];

  for (const result of normalized.labResults || []) {
    if (!result) continue;
    labRows.push({
      category: result?.category || result?.panel || null,
      isAbnormal: !!result?.isAbnormal,
      name: result?.name || result?.testName || null,
      normalRange: result?.normalRange || result?.referenceRange || null,
      unit: result?.unit || null,
      value: result?.value || null,
    });
  }

  for (const lab of normalized.labReports || []) {
    for (const result of lab?.results || []) {
      labRows.push({
        category: lab?.title || null,
        isAbnormal: !!result?.isAbnormal,
        name: result?.name || null,
        normalRange: result?.normalRange || null,
        unit: result?.unit || null,
        value: result?.value || null,
      });
    }
  }

  for (const entity of pickEntities(normalized.medicalEntities, "test_value")) {
    labRows.push({
      category: "entity",
      isAbnormal: !!entity.isAbnormal,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  for (const entity of pickEntities(normalized.medicalEntities, "abnormal_value")) {
    labRows.push({
      category: "abnormal",
      isAbnormal: true,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  return labRows.filter((row) => row.name || row.value);
}

function buildDiagnosis(normalized, summary) {
  const diseaseEntities = pickEntities(normalized.medicalEntities, "disease")
    .map((entity) => entity.value || entity.name)
    .filter(Boolean);
  return uniqueStrings([
    ...asArray(normalized.diagnosis),
    ...diseaseEntities,
    ...asArray(summary?.diagnosis),
  ]);
}

function buildVitals(normalized) {
  return asArray(normalized.vitals)
    .filter(Boolean)
    .map((vital) => (typeof vital === "string" ? { value: vital } : vital));
}

function joinForText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || null;
}

function inferFileType(mimeType) {
  if (!mimeType) return fileTypeValue[0];
  if (fileTypeValue.includes(mimeType)) return mimeType;
  return fileTypeValue[0];
}

class OcrService {
  async convertPdfToImages(pdfBuffer) {
    const tmpDir = path.resolve(__dirname, "../../../../tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const timestamp = Date.now();
    const tempPdfPath = path.join(tmpDir, `temp_${timestamp}.pdf`);
    const outputPrefix = path.join(tmpDir, `page_${timestamp}`);

    fs.writeFileSync(tempPdfPath, pdfBuffer);

    try {
      const popplerPath = env.popplerPath || "C:/poppler-26.02.0/Library/bin";
      const pdftoppmExe = path.join(popplerPath, "pdftoppm.exe");
      const cmd = `"${pdftoppmExe}" -png -r 150 "${tempPdfPath}" "${outputPrefix}"`;

      execSync(cmd, { stdio: "pipe" });

      const files = fs.readdirSync(tmpDir);
      const pageFiles = files
        .filter((f) => f.startsWith(`page_${timestamp}-`) && f.endsWith(".png"))
        .sort((a, b) => {
          const numA = parseInt(a.match(/-(\d+)\.png$/)[1]);
          const numB = parseInt(b.match(/-(\d+)\.png$/)[1]);
          return numA - numB;
        });

      const base64Images = pageFiles.map((f) => {
        const filePath = path.join(tmpDir, f);
        const data = fs.readFileSync(filePath);
        fs.unlinkSync(filePath);
        return data.toString("base64");
      });

      return base64Images;
    } catch (error) {
      console.error("[OcrService] PDF conversion failed:", error.message);
      throw error;
    } finally {
      if (fs.existsSync(tempPdfPath)) {
        fs.unlinkSync(tempPdfPath);
      }
    }
  }

  cleanAndParseJSON(text, options = {}) {
    if (!text) {
      return {
        status: "FAILED",
        error: "AI response format is invalid.",
      };
    }

    let raw = String(text).trim();

    // Preprocessing to handle common LLM output syntax anomalies
    raw = raw.replace(/\/\/.*/g, ""); // Remove single-line comments
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, ""); // Remove multi-line comments
    raw = raw.replace(/,+/g, ","); // Fix double commas
    raw = raw.replace(/,\s*([}\]])/g, "$1"); // Fix trailing commas before closing braces
    raw = raw.replace(/([{[])\s*,/g, "$1"); // Fix leading commas after opening braces

    const strategies = [
      { name: "direct_parse", fn: () => JSON.parse(raw) },
      {
        name: "markdown_code_block",
        fn: () => {
          const stripped = raw
            .replace(/```(?:json)?\s*/gi, "")
            .replace(/```\s*$/g, "")
            .trim();
          return JSON.parse(stripped);
        },
      },
      {
        name: "first_last_brace",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1) throw new Error("No structure found");
          return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        },
      },
      {
        name: "clean_trailing_commas",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1) throw new Error("No structure found");
          const cleaned = raw.slice(firstBrace, lastBrace + 1).replace(/,\s*([}\]])/g, "$1");
          return JSON.parse(cleaned);
        },
      },
      {
        name: "string_newlines_repair",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1) throw new Error("No structure found");
          let candidate = raw.slice(firstBrace, lastBrace + 1);

          let inString = false;
          let escaped = false;
          const chars = [];
          for (let i = 0; i < candidate.length; i++) {
            const char = candidate[i];
            if (escaped) {
              chars.push(char);
              escaped = false;
              continue;
            }
            if (char === "\\") {
              chars.push(char);
              escaped = true;
              continue;
            }
            if (char === '"') {
              inString = !inString;
              chars.push(char);
              continue;
            }
            if (inString) {
              if (char === "\n") {
                chars.push("\\n");
              } else if (char === "\r") {
                chars.push("\\r");
              } else if (char === "\t") {
                chars.push("\\t");
              } else {
                chars.push(char);
              }
            } else {
              chars.push(char);
            }
          }
          candidate = chars.join("");
          candidate = candidate.replace(/,\s*([}\]])/g, "$1");
          return JSON.parse(candidate);
        },
      },
      {
        name: "truncated_repair",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          if (firstBrace === -1) throw new Error("No structure found");
          const body = raw.slice(firstBrace);
          const stack = [];
          let inStr = false;
          let escaped = false;
          for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === "\\" && inStr) {
              escaped = true;
              continue;
            }
            if (ch === '"') {
              inStr = !inStr;
              continue;
            }
            if (inStr) continue;
            if (ch === "{") {
              stack.push("}");
            } else if (ch === "[") {
              stack.push("]");
            } else if (ch === "}" || ch === "]") {
              if (stack.length > 0 && stack[stack.length - 1] === ch) {
                stack.pop();
              }
            }
          }
          const closing = stack.reverse().join("");
          let repaired = body;
          if (inStr) {
            repaired += '"';
          }
          repaired += closing;
          const cleaned = repaired.replace(/,\s*([}\]])/g, "$1");
          return JSON.parse(cleaned);
        },
      },
    ];

    const parseErrors = [];
    for (const strategy of strategies) {
      try {
        const parsed = strategy.fn();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return {
            status: "SUCCESS",
            ...parsed,
          };
        }
      } catch (err) {
        parseErrors.push(`${strategy.name}: ${err.message}`);
      }
    }

    console.error("[OcrService] All parsing strategies failed.", {
      jobId: options.jobId || "N/A",
      traceId: options.traceId || "N/A",
      contentLength: raw.length,
      preview: raw.slice(0, 1000),
      parseErrors: parseErrors.join("; "),
    });

    return {
      status: "FAILED",
      error: "AI response format is invalid.",
    };
  }

  async validateDocument(file) {
    const {
      medicalDocumentClassifierService,
    } = require("../classifier/medicalDocumentClassifier.service");

    console.log("[OcrService] Delegating validation to MedicalDocumentClassifierService...");
    const classification = await medicalDocumentClassifierService.classify(file);

    return {
      status: classification.confidence > 0 ? "SUCCESS" : "FAILED",
      ...classification,
    };
  }

  async extractText(file, userLanguage = "english") {
    const isPdf =
      file.mimeType === "application/pdf" ||
      file.originalname?.toLowerCase().endsWith(".pdf") ||
      file.filename?.toLowerCase().endsWith(".pdf");

    let base64Images = [];
    if (isPdf) {
      console.log("[OcrService] Converting PDF to images using Poppler...");
      base64Images = await this.convertPdfToImages(file.buffer);
    } else {
      const processedBuffer = await preprocessImage(file.buffer);
      base64Images = [processedBuffer.toString("base64")];
    }

    const pageTexts = [];
    console.log(
      `[OcrService] Processing ${base64Images.length} page(s) sequentially with qwen3-vl:latest...`,
    );

    for (let i = 0; i < base64Images.length; i++) {
      const messages = [
        {
          role: "user",
          content: prompts.PLAIN_TEXT_OCR_PROMPT,
          images: [base64Images[i]],
        },
      ];
      const pageText = await ollamaClient.chat(messages, "qwen3-vl:latest", { temperature: 0 });
      pageTexts.push(pageText);
    }

    const rawText = pageTexts.map((text, idx) => `--- Page ${idx + 1} ---\n${text}`).join("\n\n");

    const hasGujarati = /[\u0A80-\u0AFF]/.test(rawText);
    const detectedLanguages = ["english"];
    if (hasGujarati) {
      detectedLanguages.push("gujarati");
    }
    if (
      userLanguage &&
      userLanguage.toLowerCase() !== "english" &&
      !detectedLanguages.includes(userLanguage.toLowerCase())
    ) {
      detectedLanguages.push(userLanguage.toLowerCase());
    }

    return {
      rawText,
      detectedLanguages,
      pageCount: base64Images.length,
    };
  }

  async extractMedicalDataFromText(rawText) {
    if (!rawText || !rawText.trim()) {
      return MedicalExtractionSchema.parse({});
    }

    const prompt = `You are a precise medical data extraction engine.
Analyze the following medical document text and extract structured information matching the JSON schema below.

Required JSON format:
{
  "patientName": "Full Name or null",
  "firstName": "First Name or null",
  "lastName": "Last Name or null",
  "age": "Age (number/string) or null",
  "gender": "Gender or null",
  "reportDate": "YYYY-MM-DD or null",
  "visitDate": "YYYY-MM-DD or null",
  "dateOfBirth": "YYYY-MM-DD or null",
  "doctorName": "Doctor Name or null",
  "hospitalName": "Hospital/Clinic Name or null",
  "diagnosis": "Diagnosis text/array or null",
  "medications": [
    {
      "name": "Medicine Name",
      "dosage": "Dosage (e.g. 500mg)",
      "frequency": "Frequency (e.g. Once daily)",
      "duration": "Duration (e.g. 5 days)",
      "instructions": "Instructions (e.g. After food)"
    }
  ],
  "testResults": [
    {
      "testName": "Test Name",
      "value": "Test Value",
      "unit": "Unit",
      "referenceRange": "Reference Range",
      "status": "NORMAL or ABNORMAL"
    }
  ],
  "remarks": "Any general remarks, advice or null",
  "email": "Email address or null",
  "phoneNumber": "Phone number or null",
  "bloodGroup": "Blood group (A+/A-/B+/B-/AB+/AB-/O+/O-) or null",
  "allergies": ["list", "of", "allergies", "or", "empty", "array"],
  "medicalConditions": ["list", "of", "diseases/conditions", "or", "empty", "array"],
  "address": "Postal address or null"
}

Rules:
1. Return ONLY the JSON object. Do NOT wrap in markdown code blocks. Do NOT include any other text, reasoning, explanations, or notes.
2. If a field is not present, set it to null. Do not omit the keys.
3. Be highly precise. If a field is not found or is unreadable, set it to null (or [] for arrays). Do not guess or invent data.
4. Extract patient Name, DOB/Report Date, Gender, Blood Group, Email, Phone, Allergies, Medical Conditions, Address if explicitly present in the document.
5. Implement strict field mapping:
   - Birth Date / DOB / Date of Birth -> dateOfBirth
   - Visit Date -> visitDate
   - Report Date -> reportDate

Medical Document Text:
"""
${rawText}
"""`;

    try {
      const response = await ollamaClient.generate(prompt, "qwen2.5:14b", {
        temperature: 0.1,
      });

      const parsed = this.cleanAndParseJSON(response);
      if (!parsed) {
        throw new Error("Failed to parse AI response as JSON");
      }

      let extracted = {};

      // Validate using Zod
      const validated = MedicalExtractionSchema.safeParse(parsed);
      if (!validated.success) {
        console.warn(
          "[OcrService] Zod validation failed, using fallback mapper:",
          validated.error.message,
        );
        extracted = {
          patientName: parsed.patientName || null,
          firstName: parsed.firstName || null,
          lastName: parsed.lastName || null,
          age: parsed.age || null,
          gender: parsed.gender || null,
          reportDate: parsed.reportDate || null,
          visitDate: parsed.visitDate || null,
          dateOfBirth: parsed.dateOfBirth || null,
          doctorName: parsed.doctorName || null,
          hospitalName: parsed.hospitalName || null,
          diagnosis: parsed.diagnosis || null,
          medications: Array.isArray(parsed.medications)
            ? parsed.medications.map((m) => ({
                name: m.name || null,
                dosage: m.dosage || null,
                frequency: m.frequency || null,
                duration: m.duration || null,
                instructions: m.instructions || null,
              }))
            : [],
          testResults: Array.isArray(parsed.testResults)
            ? parsed.testResults.map((t) => ({
                testName: t.testName || null,
                value: t.value || null,
                unit: t.unit || null,
                referenceRange: t.referenceRange || null,
                status: t.status || null,
              }))
            : [],
          remarks: parsed.remarks || null,
          email: parsed.email || null,
          phoneNumber: parsed.phoneNumber || null,
          bloodGroup: parsed.bloodGroup || null,
          allergies: Array.isArray(parsed.allergies) ? parsed.allergies : [],
          medicalConditions: Array.isArray(parsed.medicalConditions)
            ? parsed.medicalConditions
            : [],
          address: parsed.address || null,
        };
      } else {
        extracted = validated.data;
      }

      // Normalization & Validation Layer
      extracted.gender = normalizeGender(extracted.gender);
      extracted.bloodGroup = normalizeBloodGroup(extracted.bloodGroup);
      extracted.email = normalizeEmail(extracted.email);
      extracted.phoneNumber = normalizePhone(extracted.phoneNumber);
      extracted.reportDate = normalizeDate(extracted.reportDate);
      extracted.visitDate = normalizeDate(extracted.visitDate);

      // If reportDate is not present, fallback to visitDate
      if (!extracted.reportDate && extracted.visitDate) {
        extracted.reportDate = extracted.visitDate;
      }

      if (extracted.dateOfBirth) {
        extracted.dateOfBirth = normalizeDate(extracted.dateOfBirth);
      } else {
        extracted.dateOfBirth = null;
      }

      // If patientName is populated but firstName/lastName are empty, split the name
      if (extracted.patientName && (!extracted.firstName || !extracted.lastName)) {
        const { firstName, lastName } = splitName(extracted.patientName);
        if (!extracted.firstName) extracted.firstName = firstName;
        if (!extracted.lastName) extracted.lastName = lastName;
      }

      return extracted;
    } catch (error) {
      console.error("[OcrService] Medical structured extraction failed:", error.message);
      throw error;
    }
  }

  async extractMedicalData(file) {
    const validation = await this.validateDocument(file);
    const traceId = file.traceId || "N/A";
    const jobId = traceId.startsWith("ocr_job_") ? traceId.replace("ocr_job_", "") : "N/A";

    if (validation.status === "FAILED") {
      throw new Error("AI response format is invalid.");
    }
    if (!validation.isMedicalDocument) {
      throw new NonMedicalDocumentException(
        validation.reason || "The uploaded file is not a medical document.",
      );
    }

    const isPdf =
      file.mimeType === "application/pdf" ||
      file.filename?.toLowerCase().endsWith(".pdf") ||
      file.originalname?.toLowerCase().endsWith(".pdf");
    let rawText;

    if (isPdf) {
      rawText = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
    } else {
      const processedBuffer = await preprocessImage(file.buffer);
      const base64Image = processedBuffer.toString("base64");
      const messages = [
        {
          role: "user",
          content: prompts.PLAIN_TEXT_OCR_PROMPT,
          images: [base64Image],
        },
      ];

      console.log(
        "[OcrService] Redesigned Pipeline Step 1: Querying qwen3-vl:latest for PLAIN TEXT OCR...",
      );
      rawText = await ollamaClient.chat(messages, "qwen3-vl:latest", {
        temperature: 0,
        maxTokens: 8192,
        rawOptions: { num_ctx: 8192 },
      });
    }

    if (!rawText || !rawText.trim()) {
      throw new Error("OCR produced no usable text");
    }

    const structurePrompt = prompts.STRUCTURED_EXTRACTION_PROMPT(rawText);

    console.log(
      "[OcrService] Redesigned Pipeline Step 2: Querying qwen2.5:14b for STRUCTURED EXTRACTION...",
    );
    const jsonResponseText = await ollamaClient.generate(structurePrompt, "qwen2.5:14b", {
      temperature: 0,
      maxTokens: 8192,
      rawOptions: { num_ctx: 8192 },
    });

    const parsedOCR = this.cleanAndParseJSON(jsonResponseText, { traceId, jobId });
    if (parsedOCR.status === "FAILED") {
      throw new Error("AI response format is invalid.");
    }

    parsedOCR.rawText = rawText;

    let name = parsedOCR.patient?.name || null;
    let firstName = parsedOCR.patient?.firstName || null;
    let lastName = parsedOCR.patient?.lastName || null;
    if (name && (!firstName || !lastName)) {
      const split = splitName(name);
      if (!firstName) firstName = split.firstName;
      if (!lastName) lastName = split.lastName;
    }

    const mapped = {
      pages: [
        {
          page: 1,
          text: parsedOCR.rawText || "",
        },
      ],
      medicalExtraction: {
        patientInfo: {
          name,
          firstName,
          lastName,
          age: parsedOCR.patient?.age || null,
          gender: normalizeGender(parsedOCR.patient?.gender),
          dateOfBirth: normalizeDate(parsedOCR.patient?.dateOfBirth),
          email: normalizeEmail(parsedOCR.patient?.email),
          phoneNumber: normalizePhone(parsedOCR.patient?.phoneNumber),
          bloodGroup: normalizeBloodGroup(parsedOCR.patient?.bloodGroup),
          allergies: Array.isArray(parsedOCR.patient?.allergies) ? parsedOCR.patient.allergies : [],
          medicalConditions: Array.isArray(parsedOCR.patient?.medicalConditions)
            ? parsedOCR.patient.medicalConditions
            : [],
          address: parsedOCR.patient?.address || null,
        },
        hospitalInfo: {
          name: parsedOCR.hospital?.name || null,
        },
        doctorInfo: {
          name: parsedOCR.doctor?.name || parsedOCR.doctorName || null,
        },
        reportDate: normalizeDate(parsedOCR.reportDate),
        visitDate: normalizeDate(parsedOCR.visitDate),
        diagnosis: Array.isArray(parsedOCR.diagnosis)
          ? parsedOCR.diagnosis
          : parsedOCR.diagnosis
            ? [parsedOCR.diagnosis]
            : [],
        medications: (parsedOCR.medications || []).map((m) => ({
          name: m.name || null,
          dosage: m.dosage || null,
          frequency: m.frequency || null,
          duration: m.duration || null,
          instructions: m.instructions || null,
        })),
        labResults: (parsedOCR.labTests || parsedOCR.tests || []).map((t) => ({
          name: t.name || null,
          value: t.value || null,
          unit: t.unit || null,
          normalRange: t.referenceRange || null,
          isAbnormal: t.status === "ABNORMAL",
        })),
        summary: parsedOCR.summary || (parsedOCR.rawText ? parsedOCR.rawText.slice(0, 200) : ""),
      },
    };

    return JSON.stringify(mapped);
  }

  async generateSummary(rawText, language = "gujarati") {
    if (!rawText || !rawText.trim()) {
      return "";
    }

    const langDisplay = language.charAt(0).toUpperCase() + language.slice(1);

    const prompt = `You are a helpful medical translator. Summarize the following medical document in simple, clear ${langDisplay}.
Keep common medical terms (such as Diabetes, Hypertension, Cholesterol, Thyroid, Hemoglobin, CBC, RBC, WBC, ECG, MRI, X-ray, CT Scan, Vitamin, Calcium, and drug names) in English characters (like "Diabetes") or write them phonetically in English, as literal ${langDisplay} translations for these terms are uncommon, awkward, and confusing for patients.
The summary should be easy to understand for a layperson.
Limit the summary to 150-200 words.
Do not include any other text, markdown blocks, introductions, explanations, or notes. Output only the summary.

Medical Document Text:
"""
${rawText}
"""`;

    try {
      const response = await ollamaClient.generate(prompt, "qwen2.5:14b", {
        temperature: 0.1,
      });
      return response.trim();
    } catch (error) {
      console.error("[OcrService] Summary generation failed:", error.message);
      throw error;
    }
  }

  async checkHealth() {
    const configured = true;
    let modelValidation = { ok: false };

    try {
      const tags = await ollamaClient.listTags();
      const modelName = env.aiModel || "qwen3-vl:latest";
      const isReachable = tags.length > 0;

      modelValidation = {
        ok: isReachable,
        modelConfigured: modelName,
        modelFound: tags.some((t) => t.startsWith(modelName.split(":")[0])),
        availableModels: tags,
      };
    } catch (error) {
      modelValidation = {
        ok: false,
        error: error.message,
      };
    }

    return {
      status: modelValidation.ok ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      ai: {
        engine: "ollama",
        model: env.aiModel || "qwen3-vl:latest",
        baseUrl: env.ollamaUrl || "http://localhost:11434",
        configured,
        apiKeyPresent: false,
        modelValidation,
      },
      limits: {
        maxInlineBytes: env.aiMaxInlineBytes,
        timeoutMs: env.aiTimeoutMs,
        retries: env.aiMaxRetries,
        pageConcurrency: env.aiPageConcurrency,
        minTextChars: env.aiMinTextChars,
        minConfidence: env.aiMinConfidence,
      },
      fallback: null,
    };
  }

  async normalizeExtraction({ rawOcr, patientContext = null }) {
    const ocrPayload = rawOcr?.structuredDocument || rawOcr?.ocr || rawOcr || {};

    const normalized = {
      confidence: ocrPayload?.confidence ?? rawOcr?.metadata?.confidence ?? 0,
      fullText: ocrPayload?.fullText || ocrPayload?.text || rawOcr?.ocr_text || "",
      labReports: ocrPayload?.labReports || [],
      language: ocrPayload?.language || null,
      medicalEntities: ocrPayload?.medicalEntities || [],
      pageCount: ocrPayload?.pageCount || rawOcr?.metadata?.pageCount || 0,
      paragraphs: ocrPayload?.paragraphs || [],
      patientInfo: ocrPayload?.medicalExtraction?.patientInfo || ocrPayload?.patientInfo || {},
      hospitalInfo: ocrPayload?.medicalExtraction?.hospitalInfo || ocrPayload?.hospitalInfo || {},
      doctorInfo: ocrPayload?.medicalExtraction?.doctorInfo || ocrPayload?.doctorInfo || {},
      diagnosis: ocrPayload?.medicalExtraction?.diagnosis || ocrPayload?.diagnosis || [],
      medications: ocrPayload?.medicalExtraction?.medications || ocrPayload?.medications || [],
      labResults: ocrPayload?.medicalExtraction?.labResults || ocrPayload?.labResults || [],
      vitals: ocrPayload?.medicalExtraction?.vitals || ocrPayload?.vitals || [],
      recommendations:
        ocrPayload?.medicalExtraction?.recommendations || ocrPayload?.recommendations || [],
      summary: ocrPayload?.medicalExtraction?.summary || ocrPayload?.summary || "",
      prescriptions: ocrPayload?.prescriptions || [],
      sections: ocrPayload?.sections || [],
      tables: ocrPayload?.tables || [],
      reportDate: ocrPayload?.medicalExtraction?.reportDate || ocrPayload?.reportDate || null,
      visitDate: ocrPayload?.medicalExtraction?.visitDate || ocrPayload?.visitDate || null,
    };

    const medications = buildMedications(normalized);

    let summaryText = normalized.summary;
    if (!summaryText) {
      summaryText = normalized.fullText
        ? normalized.fullText.slice(0, 500)
        : "No summary available.";
    }

    const summary = {
      summary: summaryText,
      documentType: ocrPayload?.documentType || null,
      diagnosis: normalized.diagnosis,
      medications,
      keyFindings: normalized.diagnosis,
      followUps: normalized.recommendations,
      recommendations: normalized.recommendations,
    };

    const allergyEntities = pickEntities(normalized.medicalEntities, "allergy");
    const bloodGroupEntities = pickEntities(normalized.medicalEntities, "blood_group");
    const labResults = buildLabResults(normalized);
    const doctorName =
      asObject(normalized.doctorInfo).name ||
      pickFirstField(normalized.prescriptions, "doctorName") ||
      pickEntities(normalized.medicalEntities, "doctor_name")[0]?.name ||
      null;
    const hospitalName =
      asObject(normalized.hospitalInfo).name ||
      pickFirstField(normalized.sections, "hospitalName") ||
      null;
    const patientName =
      asObject(normalized.patientInfo).name ||
      normalized.patientName ||
      pickEntities(normalized.medicalEntities, "patient_name")[0]?.name ||
      patientContext?.fullName ||
      null;
    const diagnosis = buildDiagnosis(normalized, summary);
    const recommendations = uniqueStrings([
      ...asArray(normalized.recommendations).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v),
      ),
      ...asArray(summary?.followUps).map((v) => (typeof v === "string" ? v : JSON.stringify(v))),
      ...asArray(summary?.recommendations).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v),
      ),
    ]);
    const finalSummary = summary?.summary || normalized.summary || "";

    const structured = {
      patientInfo: {
        ...asObject(normalized.patientInfo),
        ...(patientName ? { name: patientName } : {}),
      },
      hospitalInfo: {
        ...asObject(normalized.hospitalInfo),
        ...(hospitalName ? { name: hospitalName } : {}),
      },
      doctorInfo: {
        ...asObject(normalized.doctorInfo),
        ...(doctorName ? { name: doctorName } : {}),
      },
      diagnosis,
      medications,
      labResults,
      vitals: buildVitals(normalized),
      recommendations,
      summary: finalSummary,

      allergies: uniqueStrings(allergyEntities.map((e) => e.value || e.name)),
      bloodGroup: bloodGroupEntities[0]?.value || bloodGroupEntities[0]?.name || null,
      diagnosisText: joinForText(diagnosis),
      doctorName,
      hospitalName,
      observations: asArray(summary?.keyFindings || summary?.observations).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      ),
      patientName,
      reportDate: normalized.reportDate || pickReportDate(normalized),
      visitDate: normalized.visitDate || null,
      reportType: summary?.documentType || normalized?.documentType || null,
      testResults: labResults,
    };

    const rawOcrData = {
      blocks: ocrPayload?.paragraphs || [],
      confidence: ocrPayload?.confidence ?? rawOcr?.metadata?.confidence ?? null,
      engine: rawOcr?.metrics?.engine || "pymupdf",
      fullText: ocrPayload?.fullText || ocrPayload?.text || rawOcr?.ocr_text || "",
      language: ocrPayload?.language || null,
      metrics: rawOcr?.metrics || {},
      pageCount: ocrPayload?.pageCount || rawOcr?.metadata?.pageCount || 0,
      pages: ocrPayload?.pages || [],
      processingSeconds: rawOcr?.metrics?.processing_seconds ?? null,
      tables: ocrPayload?.tables || [],
      usedDirectText: !!rawOcr?.metrics?.used_direct_text,
      usedOcr: !!rawOcr?.metrics?.used_ocr,
      usedQwenVl: !!rawOcr?.metrics?.used_qwen_vl,
    };

    return { normalized, rawOcrData, structured, summary };
  }

  async processAndStoreSynchronously({ file, userId }) {
    console.log(`[OcrService] [START] processAndStoreSynchronously for user: ${userId}`);

    // Fetch preferred language from onboarding state
    let preferredLanguage = "gujarati";
    if (userId) {
      try {
        const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
        const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
        if (onboardingRecord && onboardingRecord.data && onboardingRecord.data.preferredLanguage) {
          preferredLanguage = onboardingRecord.data.preferredLanguage;
        }
      } catch (err) {
        console.warn(
          `[OcrService] Failed to fetch preferred language for user ${userId}, defaulting to gujarati`,
          err.message,
        );
      }
    }

    // 0. Classify document before upload
    const tClassifyStart = Date.now();
    const {
      medicalDocumentClassifierService,
    } = require("../classifier/medicalDocumentClassifier.service");
    const classification = await medicalDocumentClassifierService.classify(file);
    console.log(
      `[OcrService] [CLASSIFY] Duration: ${Date.now() - tClassifyStart}ms. Result:`,
      classification,
    );

    if (!classification.isMedicalDocument) {
      throw new NonMedicalDocumentException(
        classification.reason || "The uploaded file is not a medical document.",
        classification,
      );
    }

    // 1. Upload file
    const tUploadStart = Date.now();
    const uploadResult = await uploadFileService.uploadFile(file, "PATIENT_DOCUMENT", userId);
    console.log(
      `[OcrService] [UPLOAD] Duration: ${Date.now() - tUploadStart}ms. key=${uploadResult.data.fileKey}. Starting OCR...`,
    );

    // 2. Perform OCR
    const tOcrStart = Date.now();
    const ocrResult = await this.extractText(file, preferredLanguage);
    console.log(
      `[OcrService] [OCR] Duration: ${Date.now() - tOcrStart}ms. Page count = ${ocrResult.pageCount}. Extracting structured data...`,
    );

    // 3. Extract structured medical data
    const tExtractStart = Date.now();
    const structuredData = await this.extractMedicalDataFromText(ocrResult.rawText);
    console.log(
      `[OcrService] [EXTRACT] Duration: ${Date.now() - tExtractStart}ms. Structured extraction complete. Generating Gujarati summary...`,
    );

    // 4. Generate summary in selected language
    const tSummaryStart = Date.now();
    const summaryGujarati = await this.generateSummary(ocrResult.rawText, preferredLanguage);
    console.log(
      `[OcrService] [SUMMARY] Duration: ${Date.now() - tSummaryStart}ms. Summary generated in ${preferredLanguage}. Saving to database...`,
    );

    // 5. Store in database
    const tDbStart = Date.now();
    const fileKey = uploadResult.data.fileKey;
    const bucketName =
      uploadResult.data.s3Bucket ||
      (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);
    const filePath =
      env.storageProvider === "gcp"
        ? `gs://${bucketName}/${fileKey}`
        : `https://${bucketName}.s3.amazonaws.com/${fileKey}`;

    const [documentRow] = await db
      .insert(document)
      .values({
        userId,
        documentType: "medical_document",
        fileName: uploadResult.data.originalFileName,
        filePath,
        s3Bucket: bucketName,
        s3Key: fileKey,
        fileType: inferFileType(uploadResult.data.mimeType),
        fileSize: uploadResult.data.fileSize,
        ocrStatus: ocrStatus.COMPLETED,
        ocrExtractedText: ocrResult.rawText,
        structuredExtractedData: structuredData,
        reportDate: structuredData.reportDate ? new Date(structuredData.reportDate) : null,
        hospitalName: structuredData.hospitalName || null,
        doctorName: structuredData.doctorName || null,
        remarks: structuredData.remarks || null,
        summaryGujarati,
      })
      .returning();
    console.log(
      `[OcrService] [DATABASE] Duration: ${Date.now() - tDbStart}ms. ID=${documentRow.id}. Indexing in RAG...`,
    );

    // 6. Index Document in RAG
    const { embeddingService } = require("../chat/embedding.service");
    await embeddingService.embedAndPersist({
      documentId: documentRow.id,
      userId,
      rawOcr: {
        fullText: ocrResult.rawText,
        language: ocrResult.detectedLanguages?.join(",") || "en",
      },
      structured: {
        summary: summaryGujarati,
        observations: Array.isArray(structuredData.diagnosis)
          ? structuredData.diagnosis
          : structuredData.diagnosis
            ? [structuredData.diagnosis]
            : [],
        recommendations: structuredData.remarks ? [structuredData.remarks] : [],
        medications: (structuredData.medications || []).map((m) => JSON.stringify(m)),
      },
    });

    console.log(`[OcrService] RAG indexing completed.`);

    return {
      document: documentRow,
      ocrResult,
      structuredData,
    };
  }
}

const ocrService = new OcrService();

module.exports = {
  OcrService,
  ocrService,
};
