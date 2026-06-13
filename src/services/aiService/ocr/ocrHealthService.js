const { env } = require("../../../configs/env");
const aiOcrService = require("./geminiOcrService");

class OcrHealthService {
  async check() {
    const configured = aiOcrService.isConfigured;
    const client = configured ? aiOcrService.provider() : null;
    const modelValidation = client?.validateModelAvailable
      ? await client.validateModelAvailable()
      : { ok: configured };
    return {
      status: configured && modelValidation.ok ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      ai: {
        engine: client?.status().engine || null,
        model: env.aiModel,
        baseUrl: env.aiBaseUrl,
        configured,
        apiKeyPresent: Boolean(env.aiApiKey),
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
