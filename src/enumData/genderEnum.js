const { pgEnum } = require("drizzle-orm/pg-core");
const genderValues=["male", "female"];
const genderEnum = pgEnum("gender_enum", genderValues );

module.exports = { genderEnum,genderValues };