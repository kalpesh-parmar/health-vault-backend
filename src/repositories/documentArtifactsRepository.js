const { and, eq } = require("drizzle-orm");

const { db } = require("../configs/db");
const {
  documentAiSummary,
  documentOcrRawData,
  documentPages,
  medicalGraph,
} = require("../models/documentArtifacts");

class DocumentArtifactsRepository {
  constructor(client = db) {
    this.client = client;
  }

  withTransaction(callback) {
    return db.transaction((tx) => callback(new DocumentArtifactsRepository(tx)));
  }

  async upsertOcrRaw(data) {
    const [existing] = await this.client
      .select()
      .from(documentOcrRawData)
      .where(eq(documentOcrRawData.documentId, data.documentId))
      .limit(1);

    if (existing) {
      const [updated] = await this.client
        .update(documentOcrRawData)
        .set(data)
        .where(eq(documentOcrRawData.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await this.client.insert(documentOcrRawData).values(data).returning();
    return created;
  }

  async replacePages(documentId, pages) {
    await this.client.delete(documentPages).where(eq(documentPages.documentId, documentId));
    if (!pages.length) return [];
    return this.client.insert(documentPages).values(pages).returning();
  }

  async upsertAiSummary(data) {
    const [existing] = await this.client
      .select()
      .from(documentAiSummary)
      .where(eq(documentAiSummary.documentId, data.documentId))
      .limit(1);

    if (existing) {
      const [updated] = await this.client
        .update(documentAiSummary)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(documentAiSummary.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await this.client.insert(documentAiSummary).values(data).returning();
    return created;
  }

  async replaceGraphs(documentId, graphs) {
    await this.client.delete(medicalGraph).where(eq(medicalGraph.documentId, documentId));
    if (!graphs.length) return [];
    return this.client.insert(medicalGraph).values(graphs).returning();
  }

  async findByDocumentId(documentId, userId) {
    const [raw] = await this.client
      .select()
      .from(documentOcrRawData)
      .where(
        and(eq(documentOcrRawData.documentId, documentId), eq(documentOcrRawData.userId, userId)),
      )
      .limit(1);

    const [summary] = await this.client
      .select()
      .from(documentAiSummary)
      .where(
        and(eq(documentAiSummary.documentId, documentId), eq(documentAiSummary.userId, userId)),
      )
      .limit(1);

    const pages = await this.client
      .select()
      .from(documentPages)
      .where(and(eq(documentPages.documentId, documentId), eq(documentPages.userId, userId)))
      .orderBy(documentPages.pageNumber);

    const graphs = await this.client
      .select()
      .from(medicalGraph)
      .where(and(eq(medicalGraph.documentId, documentId), eq(medicalGraph.userId, userId)));

    return { graphs, pages, raw: raw || null, summary: summary || null };
  }
}

module.exports = DocumentArtifactsRepository;
