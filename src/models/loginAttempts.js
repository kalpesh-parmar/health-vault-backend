const {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  pgEnum,
  uniqueIndex,
  index,
} = require("drizzle-orm/pg-core");
const { loginTypeValues } = require("../enums/loginType.enum");
const { providerValues } = require("../enums/providerType");
const loginTypeEnum = pgEnum("login_type", loginTypeValues);
const providerEnum = pgEnum("provider", providerValues);
const loginAttempt = pgTable(
  "login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    loginType: loginTypeEnum("login_type").notNull(),
    provider: providerEnum("provider").notNull(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at"),
    blockedUntil: timestamp("blocked_until"),
    softDelete: boolean("soft_delete").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("login_attempt_unique_idx").on(table.identifier, table.provider, table.loginType),

    index("login_attempt_provider_idx").on(table.provider),

    index("login_attempt_blocked_until_idx").on(table.blockedUntil),
  ],
);

module.exports = {
  loginAttempt,
  loginTypeEnum,
  providerEnum,
};
