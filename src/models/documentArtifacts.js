/**
 * Drizzle schemas for the OCR + AI extraction pipeline output.
 *
 * Tables:
 *   • document_pages         — one row per rendered/parsed page with raw
 *                              text and OCR confidence
 *   • document_ocr_raw_data  — single row per document with the complete
 *                              raw OCR payload + processing metrics
 *   • document_ai_summary    — single row per document with the AI
 *                              structured fields (replaces legacy AIsummary)
 *   • medical_graphs         — chart/graph data extracted from the PDF
 *
 * `document_ai_summary` is the canonical summary table. The legacy
 * `AI_Summary` Drizzle model has been removed as a duplicate.
 */

const {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} = require("drizzle-orm/pg-core");

const { document } = require("./document");
const { patient } = require("./patient");

const documentPages = pgTable(
  "document_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    rawText: text("raw_text"),
    confidence: decimal("confidence", { precision: 5, scale: 4 }),
    blocks: jsonb("blocks").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_pages_document_id_idx").on(table.documentId),
    index("document_pages_user_id_idx").on(table.userId),
    index("document_pages_page_number_idx").on(table.documentId, table.pageNumber),
  ],
);

const documentOcrRawData = pgTable(
  "document_ocr_raw_data",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" })
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    fileKey: varchar("file_key", { length: 500 }).notNull(),
    engine: varchar("engine", { length: 32 }).notNull(),
    language: varchar("language", { length: 32 }),
    pageCount: integer("page_count").default(0).notNull(),
    fullText: text("full_text"),
    tables: jsonb("tables").default([]).notNull(),
    blocks: jsonb("blocks").default([]).notNull(),
    confidence: decimal("confidence", { precision: 5, scale: 4 }),
    usedDirectText: boolean("used_direct_text").default(false).notNull(),
    usedOcr: boolean("used_ocr").default(false).notNull(),
    processingSeconds: decimal("processing_seconds", { precision: 8, scale: 3 }),
    metrics: jsonb("metrics").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_ocr_raw_data_user_id_idx").on(table.userId),
    index("document_ocr_raw_data_file_key_idx").on(table.fileKey),
  ],
);

const documentAiSummary = pgTable(
  "document_ai_summary",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" })
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    hospitalName: varchar("hospital_name", { length: 255 }),
    doctorName: varchar("doctor_name", { length: 255 }),
    patientName: varchar("patient_name", { length: 255 }),
    reportType: varchar("report_type", { length: 128 }),
    reportDate: timestamp("report_date"),
    diagnosis: text("diagnosis"),
    observations: jsonb("observations").default([]).notNull(),
    recommendations: jsonb("recommendations").default([]).notNull(),
    medications: jsonb("medications").default([]).notNull(),
    allergies: jsonb("allergies").default([]).notNull(),
    bloodGroup: varchar("blood_group", { length: 8 }),
    testResults: jsonb("test_results").default([]).notNull(),
    summary: text("summary"),
    aiModel: varchar("ai_model", { length: 128 }),
    aiProvider: varchar("ai_provider", { length: 32 }),
    rawAiResponse: jsonb("raw_ai_response"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_ai_summary_user_id_idx").on(table.userId),
    index("document_ai_summary_report_type_idx").on(table.reportType),
    index("document_ai_summary_report_date_idx").on(table.reportDate),
  ],
);

const medicalGraph = pgTable(
  "medical_graphs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    graphType: varchar("graph_type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }),
    xAxis: jsonb("x_axis").default([]).notNull(),
    yAxis: jsonb("y_axis").default([]).notNull(),
    series: jsonb("series").default([]).notNull(),
    unit: varchar("unit", { length: 64 }),
    page: integer("page"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("medical_graphs_document_id_idx").on(table.documentId),
    index("medical_graphs_user_id_idx").on(table.userId),
    index("medical_graphs_graph_type_idx").on(table.graphType),
  ],
);

module.exports = {
  documentAiSummary,
  documentOcrRawData,
  documentPages,
  medicalGraph,
};
