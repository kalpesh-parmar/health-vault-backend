const { pgEnum } = require("drizzle-orm/pg-core");

const fileType = pgEnum("file", ["PDF", "JPG","JPEG","PNG"]);

module.exports = { fileType };