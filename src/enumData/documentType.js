const { pgEnum } = require("drizzle-orm/pg-core");
const documentTypes = ["Lab Report", "Prescription","Discharge Summary","Other"];
const documentTypeEnum = pgEnum("document_type_enum", documentTypes);

module.exports = { documentTypeEnum, documentTypes };