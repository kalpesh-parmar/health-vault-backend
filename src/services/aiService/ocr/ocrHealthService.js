const { env } = require("../../../configs/env");
const { ollamaClient } = require("../../ai/ollamaClient.ts");

class OcrHealthService {
  async check() {
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
}

module.exports = new OcrHealthService();
