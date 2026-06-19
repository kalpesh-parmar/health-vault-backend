const prompts = require("../prompts");
const { ollamaClient } = require("../clients/ollamaClient");

class MedicalDocumentClassifierService {
  async classify(file) {
    const isPdf =
      file.mimeType === "application/pdf" ||
      file.filename?.toLowerCase().endsWith(".pdf") ||
      file.originalname?.toLowerCase().endsWith(".pdf");
    let responseText;

    if (isPdf) {
      const rawText = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
      const prompt = `${prompts.CLASSIFICATION_PROMPT}\n\nHere is the raw text extracted from the PDF:\n${rawText.slice(0, 4000)}`;

      console.log("[MedicalDocumentClassifierService] Validating PDF document...");
      responseText = await ollamaClient.generate(prompt, "qwen2.5:14b", { temperature: 0 });
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
      responseText = await ollamaClient.chat(messages, "qwen3-vl:latest", { temperature: 0 });
    }

    return this.cleanAndParseJSON(responseText);
  }

  cleanAndParseJSON(text) {
    if (!text) {
      return {
        isMedicalDocument: false,
        confidence: 0,
        reason: "Empty response from classifier model.",
      };
    }

    let raw = String(text).trim();
    raw = raw.replace(/\/\/.*/g, "");
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    raw = raw.replace(/,+/g, ",");
    raw = raw.replace(/,\s*([}\]])/g, "$1");
    raw = raw.replace(/([{[])\s*,/g, "$1");

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
    ];

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
        console.error("Error :", err);
        // continue
      }
    }

    return {
      isMedicalDocument: false,
      confidence: 0,
      reason: "Could not parse classifier response.",
    };
  }
}

module.exports = {
  MedicalDocumentClassifierService,
  medicalDocumentClassifierService: new MedicalDocumentClassifierService(),
};
