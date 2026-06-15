const { ollamaClient } = require("./ollamaClient.ts");

function normalizeVectorDimension(vector, targetDimension = 768) {
  if (vector.length === targetDimension) {
    return vector;
  }
  if (vector.length > targetDimension) {
    return vector.slice(0, targetDimension);
  }
  const padded = [...vector];
  while (padded.length < targetDimension) {
    padded.push(0);
  }
  return padded;
}

class EmbeddingService {
  async embedText(text) {
    if (!text || !text.trim()) {
      return new Array(768).fill(0);
    }
    const vector = await ollamaClient.embeddings(text, "nomic-embed-text:latest");
    return normalizeVectorDimension(vector, 768);
  }
}

const embeddingService = new EmbeddingService();

module.exports = {
  EmbeddingService,
  embeddingService,
};
