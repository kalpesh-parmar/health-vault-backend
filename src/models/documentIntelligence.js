/**
 * Drizzle schemas for the AI / RAG layer.
 *
 * Tables defined here (all actively read or written by repositories):
 *   • structured_documents — normalized OCR + entity extraction output
 *   • document_chunks      — text chunks that back vector search
 *   • embeddings           — pgvector rows (384-dim sentence-transformers)
 *   • medical_entities     — typed clinical entities surfaced by the LLM
 *   • ai_context_cache     — short-lived caching for chat/RAG hot path
 *   • chat_history         — single-shot RAG history (used as fallback
 *                            context when a chat session does not exist)
 *
 * The newer chat-session UI lives in models/chatSession.js. `chat_history`
 * is preserved because `documentIntelligenceRepository.getRecentChatHistory`
 * still reads from it for legacy / single-session flows.
 */

const {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  vector,
} = require("drizzle-orm/pg-core");

const { document } = require("./document");
const { patient } = require("./patient");

const aiSourceTypeEnum = pgEnum("ai_source_type", [
  "ocr_chunk",
  "summary",
  "profile",
  "reminder",
  "medication",
  "report",
  "chat",
]);

const medicalEntityTypeEnum = pgEnum("medical_entity_type", [
  "medicine",
  "dosage",
  "blood_group",
  "allergy",
  "disease",
  "test_value",
  "abnormal_value",
  "doctor_name",
  "date",
  "follow_up_instruction",
  "other",
]);

const structuredDocument = pgTable(
  "structured_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    schemaVersion: varchar("schema_version", { length: 32 }).default("2026-01").notNull(),
    language: varchar("language", { length: 32 }),
    pageCount: integer("page_count").default(0).notNull(),
    sections: jsonb("sections").default([]).notNull(),
    paragraphs: jsonb("paragraphs").default([]).notNull(),
    tables: jsonb("tables").default([]).notNull(),
    forms: jsonb("forms").default([]).notNull(),
    prescriptions: jsonb("prescriptions").default([]).notNull(),
    labReports: jsonb("lab_reports").default([]).notNull(),
    medicalEntities: jsonb("medical_entities").default([]).notNull(),
    rawOcr: jsonb("raw_ocr"),
    confidence: integer("confidence"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("structured_documents_document_id_idx").on(table.documentId),
    index("structured_documents_user_id_idx").on(table.userId),
  ],
);

const documentChunk = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id").references(() => document.id, { onDelete: "cascade" }),
    structuredDocumentId: uuid("structured_document_id").references(() => structuredDocument.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    sourceType: aiSourceTypeEnum("source_type").default("ocr_chunk").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    sectionTitle: varchar("section_title", { length: 255 }),
    content: text("content").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    tokenEstimate: integer("token_estimate").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_chunks_user_id_idx").on(table.userId),
    index("document_chunks_document_id_idx").on(table.documentId),
    index("document_chunks_source_type_idx").on(table.sourceType),
  ],
);

const embedding = pgTable(
  "embeddings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").references(() => documentChunk.id, { onDelete: "cascade" }),
    sourceType: aiSourceTypeEnum("source_type").notNull(),
    sourceId: uuid("source_id"),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("embeddings_user_id_idx").on(table.userId),
    index("embeddings_source_idx").on(table.sourceType, table.sourceId),
  ],
);

const medicalEntity = pgTable(
  "medical_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => document.id, { onDelete: "cascade" }),
    structuredDocumentId: uuid("structured_document_id").references(() => structuredDocument.id, {
      onDelete: "cascade",
    }),
    entityType: medicalEntityTypeEnum("entity_type").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    value: text("value"),
    unit: varchar("unit", { length: 64 }),
    normalRange: varchar("normal_range", { length: 255 }),
    isAbnormal: boolean("is_abnormal").default(false).notNull(),
    confidence: integer("confidence"),
    sourceText: text("source_text"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("medical_entities_user_id_idx").on(table.userId),
    index("medical_entities_document_id_idx").on(table.documentId),
    index("medical_entities_type_idx").on(table.entityType),
    index("medical_entities_name_idx").on(table.name),
  ],
);

const aiContextCache = pgTable(
  "ai_context_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    cacheKey: varchar("cache_key", { length: 255 }).notNull(),
    context: jsonb("context").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("ai_context_cache_user_id_idx").on(table.userId),
    index("ai_context_cache_key_idx").on(table.cacheKey),
  ],
);

const chatHistory = pgTable(
  "chat_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => document.id, { onDelete: "set null" }),
    sessionId: varchar("session_id", { length: 128 }),
    userMessage: text("user_message").notNull(),
    aiResponse: jsonb("ai_response").notNull(),
    citations: jsonb("citations").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("chat_history_user_id_idx").on(table.userId),
    index("chat_history_document_id_idx").on(table.documentId),
    index("chat_history_session_id_idx").on(table.sessionId),
    index("chat_history_created_at_idx").on(table.createdAt),
  ],
);

module.exports = {
  aiContextCache,
  aiSourceTypeEnum,
  chatHistory,
  documentChunk,
  embedding,
  medicalEntity,
  medicalEntityTypeEnum,
  structuredDocument,
};
