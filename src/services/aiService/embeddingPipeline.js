/**
 * Chunk + embed extracted document text and persist into pgvector.
 *
 * Reuses the existing `documentIntelligenceRepository` so we don't fork the
 * vector store. The pipeline:
 *
 *   1. Build chunks from full OCR text, summary, observations,
 *      recommendations, and medications. Each chunk carries the
 *      source-type tag so RAG search can filter / boost.
 *   2. Embed each chunk via the FastAPI service (sentence-transformers).
 *   3. Persist chunk + embedding rows in a single transaction.
 */

const { env } = require("../../configs/env");
const DocumentIntelligenceRepository = require("../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { embeddingService } = require("../ai/embeddingService.ts");
const { splitText, buildChunks } = require("../../helpers/embedding.helper");

async function embedAndPersist({
  documentId,
  userId,
  rawOcr,
  structured,
  structuredDocumentId = null,
  txRepository = intelligenceRepository,
}) {
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

  // const embeddingRows = [];
  // for (const chunk of persistedChunks) {
  //   const vector = await embeddingService.embedText(chunk.content);
  //   if (!Array.isArray(vector) || vector.length === 0) continue;
  //   embeddingRows.push({
  //     chunkId: chunk.id,
  //     embedding: vector,
  //     metadata: chunk.metadata || {},
  //     model: env.embeddingModel,
  //     sourceId: chunk.id,
  //     sourceType: chunk.sourceType,
  //     userId,
  //   });
  // }

  // if (embeddingRows.length) {
  //   await txRepository.createEmbeddings(embeddingRows);
  // }
  const embeddingRows = [];
  const promises = persistedChunks.map(async (chunk) => {
    const vector = await embeddingService.embedText(chunk.content);
    if (Array.isArray(vector) && vector.length > 0) {
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
  });
  await Promise.all(promises);

  if (embeddingRows.length) {
    await txRepository.createEmbeddings(embeddingRows);
  }

  return {
    chunkCount: persistedChunks.length,
    chunkIds: persistedChunks.map((c) => c.id),
    embeddings: embeddingRows.length,
  };
}

module.exports = { buildChunks, embedAndPersist, splitText };
