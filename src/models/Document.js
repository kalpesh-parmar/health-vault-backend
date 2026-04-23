const {
  integer,
  pgTable,
  varchar,
  serial,
  timestamp,
  boolean,
  text,
  date

} = require("drizzle-orm/pg-core");
const { User } = require("./User");
const { fileType } = require("../enumData/fileEnum");
const { ocrStatus } = require("../enumData/ocrStatus");
const { documentTypeEnum } = require("../enumData/documentType");


const Document = pgTable("documents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => User.id),
  documentType:documentTypeEnum("document_type").notNull(),
  fileName:varchar("file_name",{ length: 255 }).notNull(),
  fileStoragePath:text("file_path"),
  fileType:fileType("file").notNull(),
  fileSize:integer("file_size"),
  OCRStatus:ocrStatus("OCR_status").default("Pending").notNull(),
  ocrextractedText:text("OCR_extracted_text"),
  structuredExtractedData:varchar("structured_extracted_data"),
  reportDate:date("report_date"),
  hospitalName:varchar("hospital_name").notNull(),
  doctorName:varchar("doctor_name" , {length:25}).notNull(),
  remarks:text("reamrk"),
  softDelete: boolean("soft_delete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { Document };
