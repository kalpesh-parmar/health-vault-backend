const prompts = require("../prompts");
const { ollamaClient } = require("../clients/ollamaClient");

class MedicalDocumentClassifierService {
  async classify(file) {
    const isPdf =
      file.mimeType === "application/pdf" ||
      file.filename?.toLowerCase().endsWith(".pdf") ||
      file.originalname?.toLowerCase().endsWith(".pdf");
    let responseObj;

    if (isPdf) {
      const rawText = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
      const prompt = `${prompts.CLASSIFICATION_PROMPT}\n\nHere is the raw text extracted from the PDF:\n${rawText.slice(0, 4000)}`;

      console.log("[MedicalDocumentClassifierService] Validating PDF document...");
      responseObj = await ollamaClient.generate(prompt, "qwen2.5:14b", {
        temperature: 0,
        format: "json",
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
        "[MedicalDocumentClassifierService] Validating image document using qwen3-vl:latest...",
      );
      responseObj = await ollamaClient.chat(messages, "qwen3-vl:latest", {
        temperature: 0,
        maxTokens: 2048,
        format: "json",
        fallbackToThinking: false,
        returnFullResponse: true,
      });
    }

    return this.cleanAndParseJSON(responseObj);
  }

  cleanAndParseJSON(responseObj) {
    let text = "";
    let isTruncated = false;
    let doneReason = "N/A";

    if (responseObj && typeof responseObj === "object") {
      text = responseObj.content || "";
      doneReason = responseObj.done_reason || "N/A";
      isTruncated = doneReason === "length";
    } else {
      text = String(responseObj || "");
    }

    if (!text || !text.trim()) {
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
