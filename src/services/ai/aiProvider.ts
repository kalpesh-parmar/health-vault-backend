const { qwenHealthService } = require("./qwenHealthService.ts");
const { qwenVisionService } = require("./qwenVisionService.ts");
const { embeddingService } = require("./embeddingService.ts");

class DefaultAIProvider {
  async chat(messages, mode, contextChunks = []) {
    return qwenHealthService.chat(messages, mode, contextChunks);
  }

  async embeddings(text) {
    return embeddingService.embedText(text);
  }

  async vision(file) {
    return qwenVisionService.extractMedicalData(file);
  }
}

const aiProvider = new DefaultAIProvider();

module.exports = {
  DefaultAIProvider,
  aiProvider,
};
