const { qwenHealthService } = require("./qwenHealthService.ts");
const { qwenVisionService } = require("./qwenVisionService.ts");
const { embeddingService } = require("./embeddingService.ts");

class DefaultAIProvider {
  /**
   * @param {any} messages
   * @param {any} mode
   * @param {any[]} [contextChunks]
   */
  async chat(messages, mode, contextChunks = []) {
    return qwenHealthService.chat(messages, mode, contextChunks);
  }

  /**
   * @param {any} text
   */
  async embeddings(text) {
    return embeddingService.embedText(text);
  }

  /**
   * @param {any} file
   */
  async vision(file) {
    return qwenVisionService.extractMedicalData(file);
  }
}

const aiProvider = new DefaultAIProvider();

module.exports = {
  DefaultAIProvider,
  aiProvider,
};
