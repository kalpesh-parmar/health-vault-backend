const {
  pgTable,
  serial,
  timestamp,
  boolean,
  varchar,
  integer,
} = require("drizzle-orm/pg-core");

const { User } = require("./User");

const session = pgTable("session", {
  id: serial("id").primaryKey(),

  userId: integer("user_id")
    .notNull()
    .references(() => User.id),

  loginTime: timestamp("login_time").defaultNow().notNull(),
  logoutTime: timestamp("logout_time"),
  deviceToken: varchar("device_token", { length: 500 }),
  isActive: boolean("is_active").default(true).notNull(),

  softDelete: boolean("soft_delete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { session };
