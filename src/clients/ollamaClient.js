const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");
const { env } = require("../configs/env");

class OllamaClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: apiConfig.ollama.baseURL,
      timeout: apiConfig.ollama.timeout,
    });
    this.endpoints = apiConfig.ollama.endpoints;
  }

  get baseUrl() {
    return apiConfig.ollama.baseURL;
  }

  async listTags() {
    try {
      const response = await this.client.get(this.endpoints.tags, {
        timeout: 5000,
      });
      const models = response.data?.models || [];
      return models.map((m) => m.name);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[OllamaClient] Failed to list tags:", error.message);
      return [];
    }
  }

  async requestWithRetry(requestConfig, retries = env.aiMaxRetries || 2, initialDelay = 1000) {
    let attempt = 0;
    while (true) {
      try {
        return await this.client(requestConfig);
      } catch (error) {
        attempt++;
        const isNetworkOrTimeout = !error.response || error.response.status >= 500;
        if (attempt > retries || !isNetworkOrTimeout) {
          throw error;
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
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
    const url = this.endpoints.chat;
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
        timeout: (options.timeout ?? env.aiTimeoutMs) || 300000,
        headers: { "Content-Type": "application/json" },
        signal: options.signal,
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

        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Chat Model: ${model}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Chat Done Reason: ${doneReason}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Prompt eval (input) tokens: ${promptEvalCount}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Eval (output) tokens: ${evalCount}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Content length: ${contentLen}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Thinking length: ${thinkingLen}`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Total Ollama duration: ${totalDurationMs}ms`);
        // eslint-disable-next-line no-console
        console.log(`[OllamaClient] Attempt: ${attempt}`);

        if (raw.load_duration)
          // eslint-disable-next-line no-console
          console.log(
            `[OllamaClient] Model load duration: ${(raw.load_duration / 1e6).toFixed(2)}ms`,
          );

        const contentIsEmpty = !message.content || !message.content.trim();
        if (doneReason === "length" && contentIsEmpty && attempt === 1) {
          // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
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
    const url = this.endpoints.chat;
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
      timeout: (options.timeout ?? env.aiTimeoutMs) || 300000,
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
    };

    try {
      const requestStartTime = Date.now();
      const response = await this.requestWithRetry(config);
      const baseTime = (onChunk && onChunk.startTime) || requestStartTime;

      // eslint-disable-next-line no-console
      console.log(`[STREAM DEBUG] Ollama response received +${Date.now() - baseTime}ms`);

      // STREAMING TEST ONLY
      // eslint-disable-next-line no-console
      console.log(`[STREAM TEST] LLM START`);
      const startTime = Date.now();
      let firstChunkReceived = false;
      let totalChunks = 0;
      let buffer = "";
      let isCompleted = false;

      return new Promise((resolve, reject) => {
        response.data.on("data", (chunk) => {
          // eslint-disable-next-line no-console
          console.log(`[STREAM DEBUG] Ollama data +${Date.now() - baseTime}ms`);

          if (!firstChunkReceived) {
            // STREAMING TEST ONLY
            // eslint-disable-next-line no-console
            console.log(`[STREAM TEST] FIRST LLM CHUNK after ${Date.now() - startTime}ms`);
            firstChunkReceived = true;
          }

          buffer += chunk.toString();
          const lines = buffer.split("\n");
          // Keep the last partial line in the buffer
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) {
                totalChunks++;

                if (totalChunks === 1) {
                  // eslint-disable-next-line no-console
                  console.log(`[STREAM DEBUG] FIRST TOKEN GENERATED +${Date.now() - baseTime}ms`);
                }

                if (totalChunks % 25 === 0) {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[STREAM DEBUG] Progress: ${totalChunks} chunks generated +${Date.now() - baseTime}ms`,
                  );
                }

                onChunk(parsed.message.content);
              }
              if (parsed.done) {
                // STREAMING TEST ONLY
                // eslint-disable-next-line no-console
                console.log(`[STREAM TEST] LLM COMPLETE after ${Date.now() - startTime}ms`);
                // eslint-disable-next-line no-console
                console.log(`[STREAM TEST] TOTAL CHUNKS: ${totalChunks}`);

                if (!isCompleted) {
                  isCompleted = true;
                  // eslint-disable-next-line no-console
                  console.log(`[STREAM DEBUG] stream completed +${Date.now() - baseTime}ms`);
                }
                resolve(parsed);
              }
            } catch {
              // Ignore invalid JSON that shouldn't happen with correct buffering
            }
          }
        });
        response.data.on("error", (err) => reject(err));
        response.data.on("end", () => {
          let resolved = false;
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer);
              if (parsed.done) {
                if (!isCompleted) {
                  isCompleted = true;
                  // eslint-disable-next-line no-console
                  console.log(`[STREAM DEBUG] stream completed +${Date.now() - baseTime}ms`);
                }
                resolve(parsed);
                resolved = true;
              }
            } catch {
              // ignore
            }
          }
          if (!resolved) {
            if (!isCompleted) {
              isCompleted = true;
              // eslint-disable-next-line no-console
              console.log(`[STREAM DEBUG] stream completed +${Date.now() - baseTime}ms`);
            }
            resolve({ done: true });
          }
        });
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[OllamaClient] ChatStream failed:", error.message);
      throw error;
    }
  }

  async generate(prompt, model, options = {}) {
    const url = this.endpoints.generate;
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
      timeout: (options.timeout ?? env.aiTimeoutMs) || 300000,
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
      // eslint-disable-next-line no-console
      console.error("[OllamaClient] Generate failed:", error.message);
      // eslint-disable-next-line no-console
      console.log("[Ollama error]:==", error.response);
      throw error;
    }
  }

  async embeddings(prompt, model) {
    const url = this.endpoints.embeddings;
    const payload = {
      model,
      prompt,
      keep_alive: "24h",
    };

    const config = {
      method: "post",
      url,
      data: payload,
      timeout: 300000,
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
      // eslint-disable-next-line no-console
      console.error("[OllamaClient] Embeddings failed:", error.message);
      throw error;
    }
  }

  async warmUp(model, numCtx = 8192) {
    if (!model) return;
    // eslint-disable-next-line no-console
    console.log(`[OllamaClient] Pre-warming GPU VRAM for model '${model}' (num_ctx: ${numCtx})...`);
    try {
      await this.generate("", model, {
        keep_alive: "24h",
        rawOptions: { num_ctx: numCtx },
        timeout: 10000,
      });
      // eslint-disable-next-line no-console
      console.log(`[OllamaClient] Warm-up completed successfully for model '${model}'.`);
    } catch (err) {
      // eslint-disable-next-line no-console
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
