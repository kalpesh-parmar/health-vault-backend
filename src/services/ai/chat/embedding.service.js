const { env } = require("../../../configs/env");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { ollamaClient } = require("../clients/ollamaClient");

const CHUNK_TARGET_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 250;

function normalizeVectorDimension(vector, targetDimension = env.embeddingDim || 1024) {
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

  // Handle observations / diagnosis
  const observations = structured?.observations || asArray(structured?.diagnosis);
  for (const observation of observations) {
    if (!observation) continue;
    const text = typeof observation === "string" ? observation : JSON.stringify(observation);
    chunks.push({
      content: text.startsWith("Diagnosis:") ? text : `Diagnosis: ${text}`,
      metadata: { kind: "observation" },
      sectionTitle: "Observation",
      sourceType: "report",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  // Handle recommendations / remarks
  const recommendations =
    structured?.recommendations || (structured?.remarks ? [structured.remarks] : []);
  for (const recommendation of recommendations) {
    if (!recommendation) continue;
    const text =
      typeof recommendation === "string" ? recommendation : JSON.stringify(recommendation);
    chunks.push({
      content: text.startsWith("Remarks:") ? text : `Remarks: ${text}`,
      metadata: { kind: "recommendation" },
      sectionTitle: "Recommendation",
      sourceType: "report",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  for (const med of structured?.medications || []) {
    if (!med) continue;
    let text = typeof med === "string" ? med : "";
    if (typeof med === "object") {
      text = `Medication: ${med.name || ""}, Dosage: ${med.dosage || ""}, Frequency: ${med.frequency || ""}, Duration: ${med.duration || ""}, Instructions: ${med.instructions || ""}`;
    }
    chunks.push({
      content: text,
      metadata: { kind: "medication" },
      sectionTitle: "Medication",
      sourceType: "medication",
      tokenEstimate: Math.ceil(text.length / 4),
    });
  }

  // Handle lab/test results if present (from sync flow)
  if (Array.isArray(structured?.testResults)) {
    structured.testResults.forEach((test, idx) => {
      const testText = `Lab Test: ${test.testName || ""}, Value: ${test.value || ""}, Unit: ${test.unit || ""}, Reference Range: ${test.referenceRange || ""}, Status: ${test.status || ""}`;
      chunks.push({
        content: testText,
        metadata: { kind: "lab_test", index: idx },
        sectionTitle: "Lab Test Details",
        sourceType: "report",
        tokenEstimate: Math.ceil(testText.length / 4),
      });
    });
  }

  return chunks;
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

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
// module.exports = new EmbeddingService();

module.exports = {
  embeddingService: new EmbeddingService(),
  buildChunks,
  splitText,
};
