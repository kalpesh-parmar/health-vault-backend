const {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  uniqueIndex,
  boolean,
} = require("drizzle-orm/pg-core");
const { patient } = require("./patient");
const { providerValues } = require("../enums/providerType");
const providerEnum = pgEnum("provider", providerValues);
const authProvider = pgTable(
  "auth_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    softDelete: boolean("soft_delete").default(false).notNull(),
  },
  (table) => [uniqueIndex("auth_provider_unique_idx").on(table.provider, table.providerUserId)],
);

module.exports = { authProvider };
