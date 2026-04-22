const { pgEnum } = require("drizzle-orm/pg-core");

const ocrStatus = pgEnum("status", ["Pending","Processing","Completed","Failed"]);

module.exports = { ocrStatus };