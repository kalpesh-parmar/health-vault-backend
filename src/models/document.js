const {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  jsonb,
} = require("drizzle-orm/pg-core");

const { documentTypeValue } = require("../enums/documentType");
const { fileTypeValue } = require("../enums/fileType");
const { ocrStatus, ocrStatusValue } = require("../enums/ocrStatus");
const { patient } = require("./patient");
const documentTypeEnum = pgEnum("document_type", documentTypeValue);
const fileTypeEnum = pgEnum("file_type", fileTypeValue);
const ocrStatusEnum = pgEnum("ocr_status", ocrStatusValue);

const document = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentType: documentTypeEnum("document_type").notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    filePath: text("file_path").notNull(),
    s3Bucket: varchar("s3_bucket", { length: 255 }),
    s3Key: varchar("s3_key", { length: 500 }),
    fileType: fileTypeEnum("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    ocrStatus: ocrStatusEnum("ocr_status").default(ocrStatus.PENDING),
    ocrExtractedText: text("ocr_extracted_text"),
    structuredExtractedData: jsonb("structured_extracted_data"),
    reportDate: date("report_date", { mode: "date" }),
    hospitalName: varchar("hospital_name", { length: 255 }),
    doctorName: varchar("doctor_name", { length: 255 }),
    remarks: text("remarks"),
    softDelete: boolean("soft_delete").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("documents_user_id_idx").on(table.userId),
    index("documents_type_idx").on(table.documentType),
    index("documents_soft_delete_idx").on(table.softDelete),
    index("documents_report_date_idx").on(table.reportDate),
    index("documents_created_at_idx").on(table.createdAt),
  ],
);

module.exports = { document };
