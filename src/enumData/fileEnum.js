const { pgEnum } = require("drizzle-orm/pg-core");
const fileTypes= ["PDF", "JPG","JPEG","PNG"];
const fileEnum = pgEnum("file", fileTypes);

module.exports = { fileEnum, fileTypes };