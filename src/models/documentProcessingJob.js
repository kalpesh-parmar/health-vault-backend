/**
 * Drizzle schema for the async OCR job tracker.
 *
 * `document_processing_jobs` is the durable source of truth for the
 * non-blocking OCR pipeline. The runner (`documentOcrJobService`) writes
 * stage transitions here so the FE can either subscribe to SSE for live
 * updates or poll `GET /documents/run-ocr-status/:fileKey` to recover
 * after a dropped connection.
 */

const {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");

const { patient } = require("./patient");

const documentProcessingJob = pgTable(
  "document_processing_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fileKey: varchar("file_key", { length: 500 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 }).notNull().default("QUEUED"),
    stage: varchar("stage", { length: 64 }),
    stageStatus: varchar("stage_status", { length: 32 }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    percentage: integer("percentage").default(0),
    currentStep: varchar("current_step", { length: 255 }),
    completedSteps: integer("completed_steps").default(0),
    pendingSteps: integer("pending_steps").default(0),
    completedStages: text("completed_stages")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    retryable: boolean("retryable"),
    requiresReupload: boolean("requires_reupload").default(false).notNull(),
    message: text("message"),
    metadata: jsonb("metadata").default({}).notNull(),
    checkpointData: jsonb("checkpoint_data").default({}).notNull(),
    rawOcrData: jsonb("raw_ocr_data"),
    extractedStructuredData: jsonb("extracted_structured_data"),
    graphs: jsonb("graphs").default([]).notNull(),
    error: text("error"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_processing_jobs_file_key_key").on(table.fileKey),
    index("document_processing_jobs_user_id_idx").on(table.userId),
    index("document_processing_jobs_status_idx").on(table.status),
    index("document_processing_jobs_expires_at_idx").on(table.expiresAt),
    index("document_processing_jobs_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

module.exports = { documentProcessingJob };
