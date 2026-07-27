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

  extractResponseText(responseData, apiType = "chat", options = {}) {
    const data = responseData || {};
    let primaryText = "";
    let thinkingText = "";

    if (apiType === "chat") {
      primaryText = data.message?.content || "";
      thinkingText = data.message?.thinking || "";
    } else {
      primaryText = data.response || "";
      thinkingText = data.thinking || "";
    }

    let text = typeof primaryText === "string" ? primaryText : "";
    const fallbackToThinking = options.fallbackToThinking ?? true;

    if (
      !text.trim() &&
      fallbackToThinking &&
      typeof thinkingText === "string" &&
      thinkingText.trim()
    ) {
      console.warn(
        `[OllamaClient] Primary response field ('${apiType === "chat" ? "message.content" : "response"}') was empty. ` +
          `Falling back to 'thinking' field (length: ${thinkingText.length}).`,
      );
      text = thinkingText;
    }

    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`Invalid response format from Ollama ${apiType}`);
    }

    let cleaned = text.trim();
    if (options.stripMarkdown !== false) {
      cleaned = cleaned
        .replace(/```(?:json)?\s*/gi, "")
        .replace(/```\s*$/g, "")
        .trim();
    }

    return cleaned;
  }

  async chat(messages, model, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    let numPredict = options.maxTokens ?? 1024;
    let attempt = 1;
    let response;
    let raw;

    while (attempt <= 2) {
      const payload = {
        model,
        messages,
        stream: false,
        keep_alive: options.keep_alive || "24h",
        think: options.think ?? false,
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: numPredict,
          ...options.rawOptions,
        },
      };

      if (options.format) {
        payload.format = options.format;
      }

      const config = {
        method: "post",
        url,
        data: payload,
        timeout: (options.timeout ?? env.aiTimeoutMs) || 90000,
        headers: { "Content-Type": "application/json" },
      };

      try {
        response = await this.requestWithRetry(config);
        raw = response.data || {};
        const message = raw.message || {};
        const doneReason = raw.done_reason || "N/A";
        const promptEvalCount = raw.prompt_eval_count || 0;
        const evalCount = raw.eval_count || 0;
        const contentLen = message.content?.length || 0;
        const thinkingLen = message.thinking?.length || 0;
        const totalDurationMs = raw.total_duration ? (raw.total_duration / 1e6).toFixed(2) : "N/A";

        console.log(`[OllamaClient] Chat Model: ${model}`);
        console.log(`[OllamaClient] Chat Done Reason: ${doneReason}`);
        console.log(`[OllamaClient] Prompt eval (input) tokens: ${promptEvalCount}`);
        console.log(`[OllamaClient] Eval (output) tokens: ${evalCount}`);
        console.log(`[OllamaClient] Content length: ${contentLen}`);
        console.log(`[OllamaClient] Thinking length: ${thinkingLen}`);
        console.log(`[OllamaClient] Total Ollama duration: ${totalDurationMs}ms`);
        console.log(`[OllamaClient] Attempt: ${attempt}`);

        if (raw.load_duration)
          console.log(
            `[OllamaClient] Model load duration: ${(raw.load_duration / 1e6).toFixed(2)}ms`,
          );

        // Check retry conditions:
        // - done_reason === "length"
        // - message.content is empty
        // - first attempt failed
        const contentIsEmpty = !message.content || !message.content.trim();
        if (doneReason === "length" && contentIsEmpty && attempt === 1) {
          console.warn(
            `[OllamaClient] Response truncated (done_reason=length with empty content). Retrying with larger output budget (attempt 2)...`,
          );
          numPredict = Math.min((options.maxTokens || 1024) * 2, 8192);
          if (numPredict < 4096) numPredict = 4096;
          attempt++;
          continue;
        }

        break;
      } catch (error) {
        console.error(`[OllamaClient] Chat attempt ${attempt} failed:`, error.message);
        throw error;
      }
    }

    const text = this.extractResponseText(raw, "chat", options);

    if (options.returnFullResponse) {
      return {
        text,
        content: raw.message?.content || "",
        thinking: raw.message?.thinking || "",
        done_reason: raw.done_reason,
        prompt_eval_count: raw.prompt_eval_count || 0,
        eval_count: raw.eval_count || 0,
        content_len: (raw.message?.content || "").length,
        thinking_len: (raw.message?.thinking || "").length,
        total_duration: raw.total_duration,
        retry_attempts: attempt - 1,
      };
    }

    return text;
  }

  async chatStream(messages, model, onChunk, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const payload = {
      model,
      messages,
      stream: true,
      keep_alive: options.keep_alive || "24h",
      think: options.think ?? false,
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
      keep_alive: options.keep_alive || "24h",
      think: options.think ?? false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 8192,
        ...options.rawOptions,
      },
    };

    if (options.format) {
      payload.format = options.format;
    }

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: (options.timeout ?? env.aiTimeoutMs) || 90000,
      headers: { "Content-Type": "application/json" },
    };

    try {
      const response = await this.requestWithRetry(config);
      const raw = response.data || {};
      const text = this.extractResponseText(raw, "generate", options);

      if (options.returnFullResponse) {
        return {
          text,
          content: raw.response || "",
          thinking: raw.thinking || "",
          done_reason: raw.done_reason,
          prompt_eval_count: raw.prompt_eval_count || 0,
          eval_count: raw.eval_count || 0,
          content_len: (raw.response || "").length,
          thinking_len: (raw.thinking || "").length,
          total_duration: raw.total_duration,
        };
      }

      return text;
    } catch (error) {
      console.error("[OllamaClient] Generate failed:", error.message);
      console.log("[Ollama error]:==", error.response);

      throw error;
    }
  }

  async embeddings(prompt, model) {
    const url = `${this.baseUrl}/api/embeddings`;
    const payload = {
      model,
      prompt,
      keep_alive: "24h",
    };

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: 60000,
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

  async warmUp(model, numCtx = 8192) {
    if (!model) return;
    console.log(`[OllamaClient] Pre-warming GPU VRAM for model '${model}' (num_ctx: ${numCtx})...`);
    try {
      await this.generate("", model, {
        keep_alive: "24h",
        rawOptions: { num_ctx: numCtx },
        timeout: 10000,
      });
      console.log(`[OllamaClient] Warm-up completed successfully for model '${model}'.`);
    } catch (err) {
      console.warn(
        `[OllamaClient] Warm-up ping failed (model will load on first request):`,
        err.message,
      );
    }
  }
}

const ollamaClient = new OllamaClient();

module.exports = {
  OllamaClient,
  ollamaClient,
};
