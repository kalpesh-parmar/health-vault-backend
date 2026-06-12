const { and, desc, eq, inArray, sql } = require("drizzle-orm");

const { db } = require("../configs/db");
const {
  aiContextCache,
  chatHistory,
  documentChunk,
  embedding,
  medicalEntity,
  structuredDocument,
} = require("../models/documentIntelligence");
const { medication } = require("../models/medication");
const { notification } = require("../models/notification");
const { patient } = require("../models/patient");

function toVectorLiteral(values) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

class DocumentIntelligenceRepository {
  constructor(client = db) {
    this.client = client;
  }

  async withTransaction(callback) {
    return db.transaction((tx) => callback(new DocumentIntelligenceRepository(tx)));
  }

  async deleteForDocument(documentId) {
    await this.client.delete(embedding).where(eq(embedding.sourceId, documentId));
    await this.client.delete(medicalEntity).where(eq(medicalEntity.documentId, documentId));
    await this.client.delete(documentChunk).where(eq(documentChunk.documentId, documentId));
    await this.client
      .delete(structuredDocument)
      .where(eq(structuredDocument.documentId, documentId));
  }

  async createStructuredDocument(data) {
    const result = await this.client.insert(structuredDocument).values(data).returning();
    return result[0] || null;
  }

  async createChunks(chunks) {
    if (!chunks.length) {
      return [];
    }
    return this.client.insert(documentChunk).values(chunks).returning();
  }

  async createEmbeddings(rows) {
    if (!rows.length) {
      return [];
    }
    return this.client.insert(embedding).values(rows).returning();
  }

  async createMedicalEntities(entities) {
    if (!entities.length) {
      return [];
    }
    return this.client.insert(medicalEntity).values(entities).returning();
  }

  async findStructuredDocumentByDocumentId(documentId, userId) {
    const result = await this.client
      .select()
      .from(structuredDocument)
      .where(
        and(eq(structuredDocument.documentId, documentId), eq(structuredDocument.userId, userId)),
      )
      .limit(1);
    return result[0] || null;
  }

  async searchSimilarChunks({ userId, queryEmbedding, limit, documentId }) {
    const vectorLiteral = toVectorLiteral(queryEmbedding);
    const conditions = [eq(embedding.userId, userId)];
    if (documentId) {
      conditions.push(eq(documentChunk.documentId, documentId));
    }
    return this.client
      .select({
        chunkId: documentChunk.id,
        documentId: documentChunk.documentId,
        sectionTitle: documentChunk.sectionTitle,
        content: documentChunk.content,
        metadata: documentChunk.metadata,
        sourceType: documentChunk.sourceType,
        distance: sql`${embedding.embedding} <=> ${vectorLiteral}::vector`,
      })
      .from(embedding)
      .innerJoin(documentChunk, eq(embedding.chunkId, documentChunk.id))
      .where(and(...conditions))
      .orderBy(sql`${embedding.embedding} <=> ${vectorLiteral}::vector`)
      .limit(limit);
  }

  async createChatHistory(data) {
    const result = await this.client.insert(chatHistory).values(data).returning();
    return result[0] || null;
  }

  async getRecentChatHistory({ userId, sessionId, limit = 8 }) {
    const conditions = [eq(chatHistory.userId, userId)];
    if (sessionId) {
      conditions.push(eq(chatHistory.sessionId, sessionId));
    }
    return this.client
      .select()
      .from(chatHistory)
      .where(and(...conditions))
      .orderBy(desc(chatHistory.createdAt))
      .limit(limit);
  }

  async getPatientContext(userId) {
    const result = await this.client
      .select({
        id: patient.id,
        patientCode: patient.patientCode,
        fullName: patient.fullName,
        gender: patient.gender,
        age: patient.age,
        phone: patient.phone,
        email: patient.email,
      })
      .from(patient)
      .where(and(eq(patient.id, userId), eq(patient.softDelete, false)))
      .limit(1);
    return result[0] || null;
  }

  async getMedicationContext(userId) {
    return this.client
      .select()
      .from(medication)
      .where(and(eq(medication.userId, userId), eq(medication.softDelete, false)));
  }

  async getReminderContext(userId) {
    return this.client
      .select()
      .from(notification)
      .where(eq(notification.userId, userId))
      .orderBy(desc(notification.createdAt))
      .limit(20);
  }

  async getMedicalEntities({ userId, entityTypes = [] }) {
    const conditions = [eq(medicalEntity.userId, userId)];
    if (entityTypes.length) {
      conditions.push(inArray(medicalEntity.entityType, entityTypes));
    }
    return this.client
      .select()
      .from(medicalEntity)
      .where(and(...conditions));
  }

  async findContextCache(userId, cacheKey) {
    const result = await this.client
      .select()
      .from(aiContextCache)
      .where(and(eq(aiContextCache.userId, userId), eq(aiContextCache.cacheKey, cacheKey)))
      .limit(1);
    return result[0] || null;
  }

  async upsertContextCache(data) {
    const existing = await this.findContextCache(data.userId, data.cacheKey);
    if (existing) {
      const result = await this.client
        .update(aiContextCache)
        .set({ context: data.context, expiresAt: data.expiresAt, updatedAt: new Date() })
        .where(eq(aiContextCache.id, existing.id))
        .returning();
      return result[0] || null;
    }
    const result = await this.client.insert(aiContextCache).values(data).returning();
    return result[0] || null;
  }
}

module.exports = DocumentIntelligenceRepository;
