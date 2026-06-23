const { pgTable, uuid, varchar, timestamp } = require("drizzle-orm/pg-core");
const { patient } = require("./patient");

const authProvider = pgTable("auth_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => patient.id, { onDelete: "cascade" }),
  providerType: varchar("provider_type", { length: 50 }).notNull(),
  providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { authProvider };
