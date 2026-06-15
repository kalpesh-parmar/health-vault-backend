const { ollamaClient } = require("./ollamaClient.ts");
const {
  EMERGENCY_KEYWORDS,
  EMERGENCY_WARNING,
  GENERAL_HEALTH_PROMPT,
  RAG_PROMPT_TEMPLATE,
} = require("./promptTemplates.ts");

class QwenHealthService {
  detectEmergency(text) {
    const cleanText = text.toLowerCase();
    return EMERGENCY_KEYWORDS.some((keyword) => cleanText.includes(keyword));
  }

  async chat(messages, mode, contextChunks = []) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";
    
    if (this.detectEmergency(userQuery)) {
      return {
        answer: EMERGENCY_WARNING,
        mode,
        emergency: true,
        citations: [],
      };
    }

    if (mode === "DOCUMENT_RAG") {
      if (!contextChunks || contextChunks.length === 0) {
        return {
          answer: "Information not found in uploaded reports.",
          mode,
          emergency: false,
          citations: [],
        };
      }

      const contextText = contextChunks
        .map(
          (c, idx) =>
            `[Chunk Index: ${idx + 1}, ID: ${c.chunkId}, Section: ${c.sectionTitle || "Report Content"}, Source: ${c.sourceType}, Similarity Score: ${(c.score ?? 1.0).toFixed(2)}]\nContent: ${c.content}`
        )
        .join("\n\n");

      const systemPrompt = RAG_PROMPT_TEMPLATE(contextText);
      const formattedMessages = [
        { role: "system", content: systemPrompt },
        ...messages,
      ];

      console.log("[QwenHealthService] Running local RAG chat using qwen2.5:14b...");
      const answer = await this.queryModel(formattedMessages, "qwen2.5:14b");
      return {
        answer,
        mode,
        emergency: false,
        citations: contextChunks,
      };
    }

    const formattedMessages = [
      { role: "system", content: GENERAL_HEALTH_PROMPT },
      ...messages,
    ];

    console.log("[QwenHealthService] Running local general chat using qwen2.5:14b...");
    const answer = await this.queryModel(formattedMessages, "qwen2.5:14b");
    return {
      answer,
      mode,
      emergency: false,
      citations: [],
    };
  }

  async queryModel(messages, model) {
    return ollamaClient.chat(messages, model, {
      temperature: 0.2,
      maxTokens: 2048,
    });
  }
}

const qwenHealthService = new QwenHealthService();

module.exports = {
  QwenHealthService,
  qwenHealthService,
};
