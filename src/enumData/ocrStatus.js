const { pgEnum } = require("drizzle-orm/pg-core");
const statusType=["Pending","Processing","Completed","Failed"];
const ocrStatus = pgEnum("status", statusType);

module.exports = { ocrStatus, statusType};