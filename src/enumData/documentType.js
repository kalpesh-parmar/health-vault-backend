const { pgEnum } = require("drizzle-orm/pg-core");

const documentTypeEnum = pgEnum("document_type_enum", ["Lab Report", "Prescription","Discharge Summary","Other"]);

module.exports = { documentTypeEnum };