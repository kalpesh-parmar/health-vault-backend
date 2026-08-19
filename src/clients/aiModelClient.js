const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");

class AiModelClient {
  constructor() {
    this.endpoints = {
      chatCompletions: apiConfig.chatCompletions.endpoints,
      anthropic: apiConfig.anthropic.endpoints,
    };
  }

  createBaseClient(baseUrl, timeoutMs) {
    return createHttpClient({
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: timeoutMs || 90000,
      proxy: false,
    });
  }

  async postChatCompletions({ baseUrl, payload, headers, timeoutMs }) {
    const client = this.createBaseClient(baseUrl, timeoutMs);
    const { data } = await client.post(this.endpoints.chatCompletions.completions, payload, {
      headers,
    });
    return data;
  }

  async getChatModels({ baseUrl, headers, timeoutMs }) {
    const client = this.createBaseClient(baseUrl, timeoutMs);
    const { data } = await client.get(this.endpoints.chatCompletions.models, { headers });
    return data;
  }

  async postAnthropicMessages({ baseUrl, payload, headers, timeoutMs }) {
    const client = this.createBaseClient(baseUrl, timeoutMs);
    const { data } = await client.post(this.endpoints.anthropic.messages, payload, { headers });
    return data;
  }
}

module.exports = new AiModelClient();
