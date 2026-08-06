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

const CHUNK_TARGET_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 120;

function splitText(text, { target = CHUNK_TARGET_CHARS, overlap = CHUNK_OVERLAP_CHARS } = {}) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= target) return [cleaned];

  const chunks = [];
  let cursor = 0;
  while (cursor < cleaned.length) {
    const end = Math.min(cursor + target, cleaned.length);
    chunks.push(cleaned.slice(cursor, end));
    if (end === cleaned.length) break;
    cursor = end - overlap;
  }
  return chunks;
}

function buildChunks({ rawOcr, structured }) {
  const chunks = [];

  const fullText = rawOcr?.fullText || rawOcr?.text || "";
  splitText(fullText).forEach((content, index) => {
    chunks.push({
      content,
      metadata: { language: rawOcr?.language || "en" },
      sectionTitle: `OCR page block ${index + 1}`,
      sourceType: "ocr_chunk",
      tokenEstimate: Math.ceil(content.length / 4),
    });
  });

  if (structured?.summary) {
    const summaryText = Array.isArray(structured.summary)
      ? structured.summary.join("\n")
      : String(structured.summary);
    splitText(summaryText).forEach((content) => {
      chunks.push({
        content,
        metadata: { kind: "summary" },
        sectionTitle: "AI summary",
        sourceType: "summary",
        tokenEstimate: Math.ceil(content.length / 4),
      });
    });
  }

  for (const observation of structured?.observations || []) {
    if (!observation) continue;
    const text = typeof observation === "string" ? observation : JSON.stringify(observation);
    chunks.push({
      content: text,
      metadata: { kind: "observation" },
      sectionTitle: "Observation",
      sourceType: "report",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  for (const recommendation of structured?.recommendations || []) {
    if (!recommendation) continue;
    const text =
      typeof recommendation === "string" ? recommendation : JSON.stringify(recommendation);
    chunks.push({
      content: text,
      metadata: { kind: "recommendation" },
      sectionTitle: "Recommendation",
      sourceType: "report",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  for (const med of structured?.medications || []) {
    if (!med) continue;
    const text = typeof med === "string" ? med : JSON.stringify(med);
    chunks.push({
      content: text,
      metadata: { kind: "medication" },
      sectionTitle: "Medication",
      sourceType: "medication",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  return chunks;
}

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
