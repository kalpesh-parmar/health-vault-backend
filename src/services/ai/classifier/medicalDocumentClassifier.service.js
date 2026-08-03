const pdfParse = require("pdf-parse");
const prompts = require("../prompts");
const { ollamaClient } = require("../clients/ollamaClient");
const aiClient = require("../clients/aiClient.service");
const { env } = require("../../../configs/env");

class MedicalDocumentClassifierService {
  async classify(file) {
    /*
    // --- OLD CODE (Vision Model approach) ---
    const isPdf =
      file.mimeType === "application/pdf" ||
      file.filename?.toLowerCase().endsWith(".pdf") ||
      file.originalname?.toLowerCase().endsWith(".pdf");
    let responseObj;

    if (isPdf) {
      console.log("[MedicalDocumentClassifierService] Converting PDF to image for classification...");
      const { ocrService } = require("../ocr/ocr.service");
      const base64Images = await ocrService.convertPdfToImages(file.buffer, { firstPageOnly: true });
      
      if (!base64Images || base64Images.length === 0) {
        console.error("[MedicalDocumentClassifierService] Failed to convert PDF to images.");
        return {
          isMedicalDocument: false,
          confidence: 0,
          reason: "Failed to read PDF for classification.",
        };
      }

      const messages = [
        {
          role: "user",
          content: prompts.CLASSIFICATION_PROMPT,
          images: [base64Images[0]],
        },
      ];

      console.log(
        `[MedicalDocumentClassifierService] Validating PDF document using ${env.aiModel}...`,
      );
      responseObj = await ollamaClient.chat(messages, env.aiModel, {
        temperature: 0,
        maxTokens: 2048,
        format: "json",
        fallbackToThinking: false,
        returnFullResponse: true,
      });
    } else {
      const base64Image = file.buffer.toString("base64");
      const messages = [
        {
          role: "user",
          content: prompts.CLASSIFICATION_PROMPT,
          images: [base64Image],
        },
      ];

      console.log(
        `[MedicalDocumentClassifierService] Validating image document using ${env.aiModel}...`,
      );
      responseObj = await ollamaClient.chat(messages, env.aiModel, {
        temperature: 0,
        maxTokens: 2048,
        format: "json",
        fallbackToThinking: false,
        returnFullResponse: true,
      });
    }

    return this.cleanAndParseJSON(responseObj);
    */

    // --- NEW CODE (Text Model approach using local pdf-parse + Python PaddleOCR) ---
    console.log("[MedicalDocumentClassifierService] Extracting text for validation...");

    let extractedText = "";
    try {
      const isPdf =
        file.mimetype === "application/pdf" ||
        file.mimeType === "application/pdf" ||
        file.filename?.toLowerCase().endsWith(".pdf") ||
        file.originalname?.toLowerCase().endsWith(".pdf");

      if (isPdf) {
        try {
          console.log("[MedicalDocumentClassifierService] Extracting text using pdf-parse...");
          const pdfData = await pdfParse(file.buffer);
          extractedText = pdfData.text || "";
        } catch (err) {
          console.warn(
            "[MedicalDocumentClassifierService] pdf-parse failed, likely a scanned or large PDF. Falling back to OCR...",
            err.message,
          );
          extractedText = "";
        }

        // Fallback for scanned PDFs
        if (extractedText.trim().length < 50) {
          console.log(
            "[MedicalDocumentClassifierService] PDF seems scanned, falling back to Python PaddleOCR...",
          );
          const remoteResult = await aiClient.runOcrFromBuffer({
            buffer: file.buffer,
            filename: file.originalname || file.filename || "upload",
            mimeType: file.mimetype || file.mimeType || "application/pdf",
            mode: "detailed",
          });
          extractedText =
            remoteResult.text ||
            remoteResult.rawText ||
            remoteResult.ocr_text ||
            (typeof remoteResult === "string" ? remoteResult : JSON.stringify(remoteResult));
        }
      } else {
        console.log(
          "[MedicalDocumentClassifierService] Extracting image text using Python PaddleOCR...",
        );
        const remoteResult = await aiClient.runOcrFromBuffer({
          buffer: file.buffer,
          filename: file.originalname || file.filename || "upload",
          mimeType: file.mimetype || file.mimeType || "image/png",
          mode: "detailed",
        });
        extractedText =
          remoteResult.text ||
          remoteResult.rawText ||
          remoteResult.ocr_text ||
          (typeof remoteResult === "string" ? remoteResult : JSON.stringify(remoteResult));
      }
    } catch (error) {
      console.error(
        "[MedicalDocumentClassifierService] Local OCR failed for classification:",
        error.message,
        error.stack,
      );
      return {
        isMedicalDocument: false,
        confidence: 0,
        reason: "Failed to read document for classification.",
      };
    }

    if (!extractedText || !extractedText.trim()) {
      return {
        isMedicalDocument: false,
        confidence: 0,
        reason: "No readable text found in document.",
      };
    }

    const messages = [
      {
        role: "user",
        content:
          prompts.CLASSIFICATION_TEXT_PROMPT +
          `\n\nDocument Text:\n"""\n${extractedText.substring(0, 2000)}\n"""`,
      },
    ];

    console.log(
      `[MedicalDocumentClassifierService] Validating text document using ${env.chatModel}...`,
    );
    const responseObj = await ollamaClient.chat(messages, env.chatModel, {
      temperature: 0,
      maxTokens: 512,
      format: "json",
      fallbackToThinking: false,
      returnFullResponse: true,
    });

    return this.cleanAndParseJSON(responseObj);
  }

  cleanAndParseJSON(responseObj) {
    let text = "";
    let isTruncated = false;
    let doneReason = "N/A";

    if (responseObj && typeof responseObj === "object") {
      if (typeof responseObj.text === "string" && responseObj.text.trim()) {
        text = responseObj.text;
      } else if (typeof responseObj.content === "string" && responseObj.content.trim()) {
        text = responseObj.content;
      } else if (typeof responseObj.thinking === "string" && responseObj.thinking.trim()) {
        text = responseObj.thinking;
      }
      doneReason = responseObj.done_reason || "N/A";
      isTruncated = doneReason === "length";
    } else {
      text = String(responseObj || "");
    }

    if (!text || !text.trim()) {
      console.error(
        `[MedicalDocumentClassifierService] Failed to parse classification. Content length: ${responseObj?.content?.length || 0}, Thinking length: ${responseObj?.thinking?.length || 0}`,
      );
      return {
        isMedicalDocument: false,
        confidence: 0,
        reason: isTruncated
          ? "Classifier response truncated due to output length limit (done_reason=length)."
          : "Empty response from classifier model.",
      };
    }

    let raw = text.trim();

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
        name: "key_value_fallback",
        fn: () => {
          const obj = {};
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
            if (!match) continue;
            const key = match[1].trim();
            let value = match[2].trim();
            if (/^true$/i.test(value)) value = true;
            else if (/^false$/i.test(value)) value = false;
            else if (!Number.isNaN(Number(value))) value = Number(value);
            else if (
              (value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))
            ) {
              value = value.slice(1, -1);
            }
            obj[key] = value;
          }
          if (typeof obj.isMedicalDocument !== "boolean") {
            if (obj.documentType) {
              obj.isMedicalDocument = true;
            } else {
              throw new Error("No valid isMedicalDocument field found");
            }
          }
          return obj;
        },
      },
    ];

    const parseErrors = [];
    for (const strategy of strategies) {
      try {
        const parsed = strategy.fn();
        if (parsed && typeof parsed === "object") {
          return {
            isMedicalDocument: !!parsed.isMedicalDocument,
            confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
            documentType: parsed.documentType || null,
            reason: parsed.reason || null,
          };
        }
      } catch (err) {
        parseErrors.push(`${strategy.name}: ${err.message}`);
      }
    }

    console.error(
      `[MedicalDocumentClassifierService] Failed to parse classification. Content length: ${responseObj?.content?.length || 0}, Thinking length: ${responseObj?.thinking?.length || 0}`,
    );
    console.error(
      `[MedicalDocumentClassifierService] All parsing strategies failed. Content length: ${raw.length}, doneReason: ${doneReason}. Errors: ${parseErrors.join("; ")}`,
    );

    return {
      isMedicalDocument: false,
      confidence: 0,
      reason: `Could not parse classifier response. Errors: ${parseErrors.join("; ")}`,
    };
  }
}

module.exports = {
  MedicalDocumentClassifierService,
  medicalDocumentClassifierService: new MedicalDocumentClassifierService(),
};
