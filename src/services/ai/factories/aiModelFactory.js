const axios = require("axios");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");

const { env } = require("../../../configs/env");
const { URL } = require("url");

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGeneratedText(response) {
  if (!response) return null;
  if (typeof response.text === "string") return response.text;
  if (typeof response.text === "function") return response.text();

  if (Array.isArray(response.candidates) && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    const parts = candidate.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part.text === "string") return part.text;
      }
    }
    return null;
  }

  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("");
    return text || null;
  }

  if (Array.isArray(response.content)) {
    const text = response.content
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("");
    return text || null;
  }

  try {
    const serialized = JSON.stringify(response);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    return null;
  }
  return null;
}

function shouldRetry(error) {
  if (!error.response) return true;
  return TRANSIENT_STATUS.has(error.response.status);
}

async function withRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt <= env.aiMaxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === env.aiMaxRetries) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

function sanitizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      ["authorization", "x-api-key"].includes(key.toLowerCase()) ? "<redacted>" : value,
    ]),
  );
}

function sanitizePayload(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizePayload(child)]),
    );
  }
  if (typeof value === "string" && value.length > 512) {
    return `<string len=${value.length} sha256=${crypto.createHash("sha256").update(value).digest("hex")}>`;
  }
  return value;
}

function classifyHttpError(status, body) {
  const text = String(body || "").toLowerCase();
  if ([401, 403].includes(status)) return "authentication";
  if (status === 404 && text.includes("model")) return "model_not_found";
  if (status === 400) return "invalid_payload";
  if (status === 422) return "compatibility";
  if (status >= 500) return "upstream_server_error";
  return "http_error";
}

function logAiHttpRequest({ engine, url, headers, payload }) {
  console.info(
    JSON.stringify({
      event: "ai_http_request",
      engine,
      url,
      headers: sanitizeHeaders(headers),
      body: sanitizePayload(payload),
    }),
  );
}

function logAiHttpError({ engine, url, headers, payload, error }) {
  const status = error.response?.status;
  const responseBody = error.response?.data;
  console.error(
    JSON.stringify({
      event: "ai_http_error",
      engine,
      url,
      status,
      classification: classifyHttpError(status, responseBody),
      responseBody,
      requestHeaders: sanitizeHeaders(headers),
      requestBody: sanitizePayload(payload),
      message: error.message,
    }),
  );
}

function validateChatCompletionsPayload(payload) {
  if (!payload.model) throw new Error("Invalid AI payload: model is required");
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error("Invalid AI payload: messages must be a non-empty array");
  }
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  payload.messages.forEach((message, index) => {
    if (!message || typeof message !== "object") {
      throw new Error(`Invalid AI payload: messages[${index}] must be an object`);
    }
    if (!allowedRoles.has(message.role)) {
      throw new Error(`Invalid AI payload: messages[${index}].role is invalid`);
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new Error(
        `Invalid AI payload: messages[${index}].content must be a string or content array`,
      );
    }
  });
  if ("temperature" in payload && typeof payload.temperature !== "number") {
    throw new Error("Invalid AI payload: temperature must be numeric");
  }
  if (
    "max_tokens" in payload &&
    (!Number.isInteger(payload.max_tokens) || payload.max_tokens <= 0)
  ) {
    throw new Error("Invalid AI payload: max_tokens must be a positive integer");
  }
}

class GoogleGenAiClient {
  constructor(config) {
    this.config = config;
    this.engine = "google-genai";
    this._client = null;
  }

  get client() {
    if (!this._client) {
      this._client = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
    return this._client;
  }

  async generateJson({ parts, schema, temperature = 0 }) {
    const response = await withRetry(() =>
      this.client.models.generateContent({
        model: this.config.model,
        contents: [{ role: "user", parts }],
        config: {
          temperature,
          maxOutputTokens: this.config.maxOutputTokens,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
    );
    return { raw: response, text: extractGeneratedText(response) };
  }

  status() {
    return { engine: this.engine, model: this.config.model, baseUrl: this.config.baseUrl };
  }

  async validateModelAvailable() {
    return true;
  }
}

class ChatCompletionsClient {
  constructor(config) {
    this.config = config;
    this.engine = "chat-completions";
  }

  async generateJson({ parts, temperature = 0 }) {
    const safeParts = Array.isArray(parts) ? parts : [];
    const content = safeParts.map((part) => {
      if (part.text) return { type: "text", text: part.text };
      if (part.inlineData) {
        return {
          type: "image_url",
          image_url: {
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          },
        };
      }
      return { type: "text", text: String(part) };
    });

    const response = await withRetry(async () => {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const payload = {
        model: this.config.model,
        messages: [{ role: "user", content }],
        temperature,
        max_tokens: this.config.maxOutputTokens,
        response_format: { type: "json_object" },
      };
      const headers = {
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        "Content-Type": "application/json",
      };
      validateChatCompletionsPayload(payload);
      logAiHttpRequest({ engine: this.engine, url, headers, payload });
      try {
        const { data } = await axios.post(url, payload, {
          timeout: this.config.timeoutMs,
          headers,
          proxy: false,
        });
        return data;
      } catch (error) {
        logAiHttpError({ engine: this.engine, url, headers, payload, error });
        throw error;
      }
    });
    return { raw: response, text: extractGeneratedText(response) };
  }

  status() {
    return { engine: this.engine, model: this.config.model, baseUrl: this.config.baseUrl };
  }

  async validateModelAvailable() {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/models`;
    const headers = {
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
    try {
      const { data } = await axios.get(url, {
        timeout: this.config.timeoutMs,
        headers,
        proxy: false,
      });
      const dataList = Array.isArray(data?.data) ? data.data : [];
      const models = new Set(dataList.map((model) => model.id).filter(Boolean));
      if (!models.has(this.config.model)) {
        return {
          ok: false,
          classification: "model_not_found",
          message: `Configured AI_MODEL is not available: ${this.config.model}`,
          availableModels: [...models].sort(),
        };
      }
      return { ok: true, availableModels: [...models].sort() };
    } catch (error) {
      return {
        ok: false,
        classification: classifyHttpError(error.response?.status, error.response?.data),
        message: error.message,
        status: error.response?.status,
        responseBody: error.response?.data,
      };
    }
  }
}

class AnthropicMessagesClient {
  constructor(config) {
    this.config = config;
    this.engine = "anthropic-messages";
  }

  async generateJson({ parts, temperature = 0 }) {
    const safeParts = Array.isArray(parts) ? parts : [];
    const content = safeParts.map((part) => {
      if (part.text) return { type: "text", text: part.text };
      if (part.inlineData) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.inlineData.mimeType,
            data: part.inlineData.data,
          },
        };
      }
      return { type: "text", text: String(part) };
    });

    const response = await withRetry(async () => {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
      const payload = {
        model: this.config.model,
        messages: [{ role: "user", content }],
        temperature,
        max_tokens: this.config.maxOutputTokens,
      };
      const headers = {
        ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      };
      logAiHttpRequest({ engine: this.engine, url, headers, payload });
      try {
        const { data } = await axios.post(url, payload, {
          timeout: this.config.timeoutMs,
          headers,
          proxy: false,
        });
        return data;
      } catch (error) {
        logAiHttpError({ engine: this.engine, url, headers, payload, error });
        throw error;
      }
    });
    return { raw: response, text: extractGeneratedText(response) };
  }

  status() {
    return { engine: this.engine, model: this.config.model, baseUrl: this.config.baseUrl };
  }

  async validateModelAvailable() {
    return true;
  }
}

function isGoogleGenAiEndpoint(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("googleapis.com");
  } catch {
    return false;
  }
}

function isAnthropicEndpoint(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("anthropic.com");
  } catch {
    return false;
  }
}

function createAiClient(config = env) {
  const clientConfig = {
    apiKey: config.aiApiKey,
    baseUrl: config.aiBaseUrl,
    maxOutputTokens: config.aiMaxOutputTokens,
    model: config.aiModel,
    timeoutMs: config.aiTimeoutMs,
  };

  if (isGoogleGenAiEndpoint(clientConfig.baseUrl)) return new GoogleGenAiClient(clientConfig);
  if (isAnthropicEndpoint(clientConfig.baseUrl)) return new AnthropicMessagesClient(clientConfig);
  return new ChatCompletionsClient(clientConfig);
}

module.exports = {
  createAiClient,
  createAiProvider: createAiClient,
  extractGeneratedText,
};
