const axios = require("axios");
const { env } = require("../../configs/env");

class FallbackService {
  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || env.aiApiKey || "";
    this.apiBase = process.env.DEEPSEEK_API_BASE || env.aiBaseUrl || "https://api.deepseek.com/v1";
    this.modelName = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  }

  get isConfigured() {
    return !!this.apiKey;
  }

  async chat(messages, options = {}) {
    if (!this.isConfigured) {
      throw new Error("DeepSeek Cloud Fallback is not configured (missing api_key)");
    }

    const url = `${this.apiBase.replace(/\/$/, "")}/chat/completions`;
    const payload = {
      model: this.modelName,
      messages: messages.map((m) => ({
        role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
    };

    try {
      const response = await axios.post(url, payload, {
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Invalid response content from DeepSeek Cloud");
      }
      return content;
    } catch (error) {
      console.error("[FallbackService] Chat request failed:", error.message);
      throw error;
    }
  }

  async embeddings(text) {
    if (!this.isConfigured) {
      throw new Error("DeepSeek Cloud Fallback is not configured for embeddings");
    }

    const url = `${this.apiBase.replace(/\/$/, "")}/embeddings`;
    const payload = {
      model: "deepseek-embed",
      input: text,
    };

    try {
      const response = await axios.post(url, payload, {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      const vector = response.data?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error("Invalid embeddings response from DeepSeek Cloud");
      }
      return vector;
    } catch (error) {
      console.error("[FallbackService] Embeddings request failed:", error.message);
      throw error;
    }
  }
}

const fallbackService = new FallbackService();

module.exports = {
  FallbackService,
  fallbackService,
};
