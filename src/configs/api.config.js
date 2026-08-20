const { env } = require("./env");

module.exports = {
  microsoft: {
    baseURL: env.microsoftBaseUrl || "https://login.microsoftonline.com",
    endpoints: {
      openIdConfig: (tenant = "common") => `/${tenant}/v2.0/.well-known/openid-configuration`,
      jwksKeys: (tenant = "common") => `/${tenant}/discovery/v2.0/keys`,
      commonKeys: "/common/discovery/v2.0/keys",
    },
    timeout: 5000,
  },

  facebook: {
    baseURL: env.facebookGraphBaseUrl || "https://graph.facebook.com",
    endpoints: {
      debugToken: "/debug_token",
      me: "/me",
    },
    timeout: 10000,
  },

  aiService: {
    baseURL: env.aiServiceUrl || "http://localhost:8000",
    endpoints: {
      translate: "/api/v1/translate",
      validateMedical: "/v1/validation/medical",
      runOcr: "/v1/run-ocr",
      normalize: "/v1/extraction/normalize",
      summarize: "/v1/extraction/summarize",
      embeddings: "/v1/embeddings",
      graphs: "/v1/extraction/graphs",
      detectLanguage: "/api/v1/language/detect",
    },
    timeout: env.aiTimeoutMs || 300000,
  },

  ollama: {
    baseURL: env.ollamaUrl,
    endpoints: {
      tags: "/api/tags",
      chat: "/api/chat",
      generate: "/api/generate",
      embeddings: "/api/embeddings",
    },
    timeout: env.aiTimeoutMs || 90000,
  },

  chatCompletions: {
    endpoints: {
      completions: "/chat/completions",
      models: "/models",
    },
  },

  anthropic: {
    endpoints: {
      messages: "/messages",
    },
  },
};
