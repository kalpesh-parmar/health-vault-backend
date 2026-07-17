/**
 * Drizzle schemas for the chat-session UI.
 *
 *   • chat_sessions  — top-level chat threads (sidebar list, soft-delete)
 *   • chat_messages  — user/assistant turns inside a session, cursor-paginated
 *
 * Distinct from `chat_history` (in documentIntelligence.js) which is a
 * single-row RAG transcript used by the legacy single-shot Q&A endpoint.
 * Both are runtime-used and intentionally kept.
 */

const {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} = require("drizzle-orm/pg-core");

const { patient } = require("./patient");

const chatSession = pgTable(
  "chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: jsonb("document_id"),
    title: varchar("title", { length: 255 }),
    metadata: jsonb("metadata").default({}).notNull(),
    softDelete: boolean("soft_delete").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    lastMessageAt: timestamp("last_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("chat_sessions_user_id_idx").on(table.userId),
    index("chat_sessions_document_id_idx").on(table.documentId),
    index("chat_sessions_last_message_at_idx").on(table.userId, table.lastMessageAt),
    index("chat_sessions_soft_delete_idx").on(table.softDelete),
  ],
);

const chatMessage = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSession.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    seq: integer("seq").default(0).notNull(),
  },
  (table) => [
    index("chat_messages_session_idx").on(table.sessionId, table.createdAt),
    index("chat_messages_user_id_idx").on(table.userId),
    index("chat_messages_created_at_idx").on(table.createdAt),
  ],
);

module.exports = { chatMessage, chatSession };
