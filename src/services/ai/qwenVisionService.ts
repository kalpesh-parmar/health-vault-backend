const { ollamaClient } = require("./ollamaClient.ts");
const { OCR_PROMPT, VALIDATION_PROMPT, PLAIN_TEXT_OCR_PROMPT, STRUCTURED_EXTRACTION_PROMPT } = require("./promptTemplates.ts");
const { NonMedicalDocumentException } = require("../../exceptions/appError");

class QwenVisionService {
  cleanAndParseJSON(text, options = {}) {
    if (!text) {
      console.error("[QwenVisionService] Parsing failed: empty response text.");
      return { status: "FAILED", error: "AI response format is invalid." };
    }

    const raw = String(text);
    const strategies = [
      {
        name: "direct",
        fn: () => JSON.parse(raw.trim())
      },
      {
        name: "strip_markdown_fence",
        fn: () => {
          const stripped = raw
            .replace(/```(?:json)?\s*/gi, "")
            .replace(/```\s*$/g, "")
            .trim();
          return JSON.parse(stripped);
        }
      },
      {
        name: "regex_extract",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
            throw new Error("No JSON object structure found");
          }
          const candidate = raw.slice(firstBrace, lastBrace + 1);
          return JSON.parse(candidate);
        }
      },
      {
        name: "trailing_comma_repair",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
            throw new Error("No JSON object structure found");
          }
          const candidate = raw.slice(firstBrace, lastBrace + 1);
          const cleaned = candidate.replace(/,\s*([}\]])/g, "$1");
          return JSON.parse(cleaned);
        }
      },
      {
        name: "control_char_and_comma_repair",
        fn: () => {
          const firstBrace = raw.indexOf("{");
          const lastBrace = raw.lastIndexOf("}");
          if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
            throw new Error("No JSON object structure found");
          }
          let candidate = raw.slice(firstBrace, lastBrace + 1);
          
          let inString = false;
          let escaped = false;
          let chars = [];
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
        }
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
          const repaired = body + closing;
          const cleaned = repaired.replace(/,\s*([}\]])/g, "$1");
          return JSON.parse(cleaned);
        }
      }
    ];

    const parseErrors = [];
    for (const strategy of strategies) {
      try {
        const parsed = strategy.fn();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (err) {
        parseErrors.push(`${strategy.name}: ${err.message}`);
      }
    }

    console.error("[QwenVisionService] All parsing strategies failed.", {
      jobId: options.jobId || "N/A",
      traceId: options.traceId || "N/A",
      contentLength: raw.length,
      preview: raw.slice(0, 1000),
      parseErrors: parseErrors.join("; ")
    });

    return {
      status: "FAILED",
      error: "AI response format is invalid."
    };
  }

  async validateDocument(file) {
    const isPdf = file.mimeType === "application/pdf" || file.filename?.toLowerCase().endsWith(".pdf");
    let responseText;

    if (isPdf) {
      const rawText = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
      const prompt = `${VALIDATION_PROMPT}\n\nHere is the raw text extracted from the PDF:\n${rawText.slice(0, 4000)}`;

      console.log("[QwenVisionService] Validating PDF document...");
      responseText = await ollamaClient.generate(prompt, "qwen2.5:14b", { temperature: 0 });
    } else {
      const base64Image = file.buffer.toString("base64");
      const messages = [
        {
          role: "user",
          content: VALIDATION_PROMPT,
          images: [base64Image]
        }
      ];

      console.log("[QwenVisionService] Validating image document using qwen3-vl:latest...");
      responseText = await ollamaClient.chat(messages, "qwen3-vl:latest", { temperature: 0 });
    }

    const traceId = file.traceId || "N/A";
    const jobId = traceId.startsWith("ocr_job_") ? traceId.replace("ocr_job_", "") : "N/A";

    return this.cleanAndParseJSON(responseText, { traceId, jobId });
  }

  async extractMedicalData(file) {
    // 1. Run medical document validation
    const validation = await this.validateDocument(file);
    const traceId = file.traceId || "N/A";
    const jobId = traceId.startsWith("ocr_job_") ? traceId.replace("ocr_job_", "") : "N/A";

    if (validation.status === "FAILED") {
      throw new Error("AI response format is invalid.");
    }
    if (!validation.isMedicalDocument) {
      throw new NonMedicalDocumentException(validation.reason || "The uploaded file is not a medical document.");
    }

    const isPdf = file.mimeType === "application/pdf" || file.filename?.toLowerCase().endsWith(".pdf");
    let rawText;

    if (isPdf) {
      // For PDFs, extract plain text directly from the document buffer
      rawText = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
    } else {
      // For images, run OCR first using qwen3-vl:latest to get plain text
      const base64Image = file.buffer.toString("base64");
      const messages = [
        {
          role: "user",
          content: PLAIN_TEXT_OCR_PROMPT,
          images: [base64Image]
        }
      ];

      console.log("[QwenVisionService] Redesigned Pipeline Step 1: Querying qwen3-vl:latest for PLAIN TEXT OCR...");
      rawText = await ollamaClient.chat(messages, "qwen3-vl:latest", {
        temperature: 0,
        maxTokens: 8192,
        rawOptions: { num_ctx: 8192 }
      });
    }

    if (!rawText || !rawText.trim()) {
      throw new Error("OCR produced no usable text");
    }

    // Convert the plain text into structured JSON using qwen2.5:14b (Step 2)
    const structurePrompt = STRUCTURED_EXTRACTION_PROMPT(rawText);
    
    console.log("[QwenVisionService] Redesigned Pipeline Step 2: Querying qwen2.5:14b for STRUCTURED EXTRACTION...");
    const jsonResponseText = await ollamaClient.generate(structurePrompt, "qwen2.5:14b", {
      temperature: 0,
      maxTokens: 8192,
      rawOptions: { num_ctx: 8192 }
    });

    const parsedOCR = this.cleanAndParseJSON(jsonResponseText, { traceId, jobId });
    if (parsedOCR.status === "FAILED") {
      throw new Error("AI response format is invalid.");
    }

    // Populate rawText programmatically
    parsedOCR.rawText = rawText;

    // Map the new OCR response back into the legacy format expected by the backend
    const mapped = {
      pages: [
        {
          page: 1,
          text: parsedOCR.rawText || ""
        }
      ],
      medicalExtraction: {
        patientInfo: {
          name: parsedOCR.patient?.name || null,
          age: parsedOCR.patient?.age || null,
          gender: parsedOCR.patient?.gender || null
        },
        hospitalInfo: {
          name: parsedOCR.hospital?.name || null
        },
        doctorInfo: {
          name: parsedOCR.doctor?.name || parsedOCR.doctorName || null
        },
        diagnosis: Array.isArray(parsedOCR.diagnosis) ? parsedOCR.diagnosis : (parsedOCR.diagnosis ? [parsedOCR.diagnosis] : []),
        medications: (parsedOCR.medications || []).map((m) => ({
          name: m.name || null,
          dosage: m.dosage || null,
          frequency: m.frequency || null,
          duration: m.duration || null,
          instructions: m.instructions || null
        })),
        labResults: (parsedOCR.labTests || parsedOCR.tests || []).map((t) => ({
          name: t.name || null,
          value: t.value || null,
          unit: t.unit || null,
          normalRange: t.referenceRange || null,
          isAbnormal: t.status === "ABNORMAL"
        })),
        summary: parsedOCR.summary || (parsedOCR.rawText ? parsedOCR.rawText.slice(0, 200) : "")
      }
    };

    return JSON.stringify(mapped);
  }
}

const qwenVisionService = new QwenVisionService();

module.exports = {
  QwenVisionService,
  qwenVisionService,
};
