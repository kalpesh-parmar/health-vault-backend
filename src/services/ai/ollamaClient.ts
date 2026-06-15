const axios = require("axios");
const { env } = require("../../configs/env");

class OllamaClient {
  constructor() {
    this.baseUrl = env.ollamaUrl || "http://localhost:11434";
  }

  async listTags() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000,
      });
      const models = response.data?.models || [];
      return models.map((m) => m.name);
    } catch (error) {
      console.warn("[OllamaClient] Failed to list tags:", error.message);
      return [];
    }
  }

  async chat(messages, model, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const payload = {
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 8192,
        ...options.rawOptions,
      },
    };

    console.log("[OllamaClient] Chat Outgoing Request Payload:", JSON.stringify(payload, null, 2));

    try {
      const response = await axios.post(url, payload, {
        timeout: env.aiTimeoutMs || 90000,
        headers: { "Content-Type": "application/json" },
      });
      
      console.log("[OllamaClient] Chat Incoming Response Data:", JSON.stringify(response.data, null, 2));

      const message = response.data?.message;
      if (!message) {
        throw new Error("Invalid response structure from Ollama chat");
      }

      console.log(`[OllamaClient] Chat Message Metrics: content_len=${message.content?.length || 0}, thinking_len=${message.thinking?.length || 0}, done=${response.data.done}, done_reason=${response.data.done_reason || "null"}, prompt_eval_count=${response.data.prompt_eval_count || 0}, eval_count=${response.data.eval_count || 0}`);

      let text = message.content;
      const thinking = message.thinking;
      if ((typeof text !== "string" || !text.trim()) && typeof thinking === "string" && thinking.trim()) {
        text = thinking;
      }
      if (typeof text !== "string") {
        throw new Error("Invalid response format from Ollama chat");
      }
      return text;
    } catch (error) {
      console.error("[OllamaClient] Chat failed:", error.message);
      throw error;
    }
  }

  async generate(prompt, model, options = {}) {
    const url = `${this.baseUrl}/api/generate`;
    const payload = {
      model,
      prompt,
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 8192,
        ...options.rawOptions,
      },
    };

    console.log("[OllamaClient] Generate Outgoing Request Payload:", JSON.stringify(payload, null, 2));

    try {
      const response = await axios.post(url, payload, {
        timeout: env.aiTimeoutMs || 90000,
        headers: { "Content-Type": "application/json" },
      });

      console.log("[OllamaClient] Generate Incoming Response Data:", JSON.stringify(response.data, null, 2));

      const text = response.data?.response;
      if (typeof text !== "string") {
        throw new Error("Invalid response format from Ollama generate");
      }
      return text;
    } catch (error) {
      console.error("[OllamaClient] Generate failed:", error.message);
      throw error;
    }
  }

  async embeddings(prompt, model) {
    const url = `${this.baseUrl}/api/embeddings`;
    const payload = {
      model,
      prompt,
    };

    try {
      const response = await axios.post(url, payload, {
        timeout: 10000,
        headers: { "Content-Type": "application/json" },
      });
      const vector = response.data?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error("Invalid response format from Ollama embeddings");
      }
      return vector;
    } catch (error) {
      console.error("[OllamaClient] Embeddings failed:", error.message);
      throw error;
    }
  }
}

const ollamaClient = new OllamaClient();

module.exports = {
  OllamaClient,
  ollamaClient,
};
