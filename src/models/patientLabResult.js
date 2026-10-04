const {
  boolean,
  doublePrecision,
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

const patientLabResult = pgTable(
  "patient_lab_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    reportId: varchar("report_id", { length: 255 }),
    canonicalKey: varchar("canonical_key", { length: 128 }).notNull(),
    testName: varchar("test_name", { length: 255 }).notNull(),
    valueNumeric: doublePrecision("value_numeric"),
    valueText: text("value_text"),
    unit: varchar("unit", { length: 64 }),
    referenceRange: varchar("reference_range", { length: 255 }),
    flag: varchar("flag", { length: 32 }).default("NORMAL").notNull(),
    isAbnormal: boolean("is_abnormal").default(false).notNull(),
    isCritical: boolean("is_critical").default(false).notNull(),
    testDate: timestamp("test_date", { withTimezone: true }),
    pageNo: integer("page_no").default(1).notNull(),
    confidence: doublePrecision("confidence"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("patient_lab_results_user_canonical_date_idx").on(
      table.userId,
      table.canonicalKey,
      table.testDate,
    ),
    index("patient_lab_results_document_id_idx").on(table.documentId),
    index("patient_lab_results_user_date_idx").on(table.userId, table.testDate),
    index("patient_lab_results_canonical_key_idx").on(table.canonicalKey),
  ],
);

module.exports = {
  patientLabResult,
};
