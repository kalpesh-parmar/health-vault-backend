const { boolean, index, pgTable, timestamp, uuid, varchar } = require("drizzle-orm/pg-core");

const { patient } = require("./patient");

const session = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    refreshTokenHash: varchar("refresh_token_hash", { length: 255 }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at").notNull(),
    loginTime: timestamp("login_time").defaultNow().notNull(),
    logoutTime: timestamp("logout_time"),
    deviceToken: varchar("device_token", { length: 500 }),
    isActive: boolean("is_active").default(true).notNull(),
    softDelete: boolean("soft_delete").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_refresh_token_hash_idx").on(table.refreshTokenHash),
    index("sessions_is_active_idx").on(table.isActive),
    index("sessions_soft_delete_idx").on(table.softDelete),
  ],
);

module.exports = { session };
