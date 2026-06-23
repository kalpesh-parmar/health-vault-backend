const { pgTable, uuid, varchar, boolean, timestamp } = require("drizzle-orm/pg-core");

const otpVerification = pgTable("otp_verifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  mobile: varchar("mobile", { length: 20 }).notNull(),
  otp: varchar("otp", { length: 10 }).notNull(),
  isVerified: boolean("is_verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

module.exports = { otpVerification };
