const axios = require("axios");
const { env } = require("../../../configs/env");

class OllamaClient {
  constructor() {
    this.baseUrl = env.ollamaUrl || "http://122.174.67.117:11434";
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

  async requestWithRetry(requestConfig, retries = env.aiMaxRetries || 2, initialDelay = 1000) {
    let attempt = 0;
    while (true) {
      try {
        return await axios(requestConfig);
      } catch (error) {
        attempt++;
        const isNetworkOrTimeout = !error.response || error.response.status >= 500;
        if (attempt > retries || !isNetworkOrTimeout) {
          throw error;
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.warn(
          `[OllamaClient] Request failed (attempt ${attempt}/${retries + 1}). Retrying in ${delay}ms... Error: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async chat(messages, model, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const payload = {
      model,
      messages,
      stream: false,
      think: options.think ?? false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
        ...options.rawOptions,
      },
    };

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: (options.timeout ?? env.aiTimeoutMs) || 90000,
      headers: { "Content-Type": "application/json" },
    };

    try {
      const response = await this.requestWithRetry(config);
      const message = response.data?.message;
      if (!message) {
        throw new Error("Invalid response structure from Ollama chat");
      }

      const raw = response.data || {};
      const doneReason = raw.done_reason || "N/A";
      const promptEvalCount = raw.prompt_eval_count || 0;
      const evalCount = raw.eval_count || 0;
      const contentLen = message.content?.length || 0;
      const thinkingLen = message.thinking?.length || 0;
      const totalDurationMs = raw.total_duration ? (raw.total_duration / 1e6).toFixed(2) : "N/A";

      console.log(`[OllamaClient] Chat Done Reason: ${doneReason}`);
      console.log(`[OllamaClient] Prompt eval (input) tokens: ${promptEvalCount}`);
      console.log(`[OllamaClient] Eval (output) tokens: ${evalCount}`);
      console.log(`[OllamaClient] Content length: ${contentLen}`);
      console.log(`[OllamaClient] Thinking length: ${thinkingLen}`);
      console.log(`[OllamaClient] Total Ollama duration: ${totalDurationMs}ms`);

      if (raw.load_duration)
        console.log(
          `[OllamaClient] Model load duration: ${(raw.load_duration / 1e6).toFixed(2)}ms`,
        );
      if (raw.prompt_eval_duration)
        console.log(
          `[OllamaClient] Prompt eval duration: ${(raw.prompt_eval_duration / 1e6).toFixed(2)}ms`,
        );
      if (raw.eval_duration)
        console.log(
          `[OllamaClient] Output generation duration: ${(raw.eval_duration / 1e6).toFixed(2)}ms`,
        );
      console.log(`[OllamaClient] Raw Response: ${JSON.stringify(raw)}`);

      let text = message.content;
      const thinking = message.thinking;
      if (
        (typeof text !== "string" || !text.trim()) &&
        typeof thinking === "string" &&
        thinking.trim()
      ) {
        text = thinking;
      }
      if (typeof text !== "string") {
        throw new Error("Invalid response format from Ollama chat");
      }

      if (options.returnFullResponse) {
        return {
          text,
          done_reason: raw.done_reason,
          prompt_eval_count: promptEvalCount,
          eval_count: evalCount,
          content_len: contentLen,
          thinking_len: thinkingLen,
          total_duration: raw.total_duration,
        };
      }

      return text;
    } catch (error) {
      console.error("[OllamaClient] Chat failed:", error.message);
      throw error;
    }
  }

  async chatStream(messages, model, onChunk, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const payload = {
      model,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 2048,
        ...options.rawOptions,
      },
    };

    const config = {
      method: "post",
      url,
      data: payload,
      responseType: "stream",
      timeout: (options.timeout ?? env.aiTimeoutMs) || 90000,
      headers: { "Content-Type": "application/json" },
    };

    try {
      const response = await this.requestWithRetry(config);
      return new Promise((resolve, reject) => {
        response.data.on("data", (chunk) => {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) {
                onChunk(parsed.message.content);
              }
              if (parsed.done) {
                resolve(parsed);
              }
            } catch {
              // Ignore partial JSON chunks
            }
          }
        });
        response.data.on("error", (err) => reject(err));
        response.data.on("end", () => resolve({ done: true }));
      });
    } catch (error) {
      console.error("[OllamaClient] ChatStream failed:", error.message);
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

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: (options.timeout ?? env.aiTimeoutMs) || 90000,
      headers: { "Content-Type": "application/json" },
    };

    try {
      const response = await this.requestWithRetry(config);
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

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    };

    try {
      const response = await this.requestWithRetry(config);
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
