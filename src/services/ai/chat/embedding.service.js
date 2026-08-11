const { env } = require("../../../configs/env");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { ollamaClient } = require("../clients/ollamaClient");
const {
  normalizeVectorDimension,
  splitText,
  buildChunks,
  asArray,
} = require("../../../helpers/embedding.helper");

class EmbeddingService {
  async embedText(text) {
    if (!text || !text.trim()) {
      return new Array(env.embeddingDim || 1024).fill(0);
    }
    const vector = await ollamaClient.embeddings(text, env.embeddingModel);
    return normalizeVectorDimension(vector, env.embeddingDim || 1024);
  }

  async embedAndPersist({
    documentId,
    userId,
    rawOcr,
    structured,
    structuredDocumentId = null,
    txRepository = intelligenceRepository,
  }) {
    // Check if we need to purge existing vectors first (helps in re-run)
    await txRepository.deleteForDocument(documentId).catch(() => {});

    const baseChunks = buildChunks({ rawOcr, structured });
    if (!baseChunks.length) {
      return { chunkIds: [], chunkCount: 0, embeddings: 0 };
    }

    const persistedChunks = await txRepository.createChunks(
      baseChunks.map((chunk, index) => ({
        ...chunk,
        chunkIndex: index,
        documentId,
        structuredDocumentId,
        userId,
      })),
    );

    const embeddingRows = [];
    for (const chunk of persistedChunks) {
      const vector = await this.embedText(chunk.content);
      if (!Array.isArray(vector) || vector.length === 0) continue;
      embeddingRows.push({
        chunkId: chunk.id,
        embedding: vector,
        metadata: chunk.metadata || {},
        model: env.embeddingModel,
        sourceId: chunk.id,
        sourceType: chunk.sourceType,
        userId,
      });
    }

    if (embeddingRows.length) {
      await txRepository.createEmbeddings(embeddingRows);
    }

    return {
      chunkCount: persistedChunks.length,
      chunkIds: persistedChunks.map((c) => c.id),
      embeddings: embeddingRows.length,
    };
  }
}
const embeddingService = new EmbeddingService();

module.exports = {
  embeddingService,
  buildChunks,
  splitText,
  normalizeVectorDimension,
  asArray,
};
