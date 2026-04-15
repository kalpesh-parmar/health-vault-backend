const {
  serial,
  pgTable,
  varchar,
  timestamp,
  boolean,
} = require("drizzle-orm/pg-core");

const user = pgTable("users", {
  id: serial("id").primaryKey(),

  userName: varchar("user_name", { length: 255 }).notNull(),

  // firstName: varchar("first_name", { length: 255 }).notNull(),
  // lastName: varchar("last_name", { length: 255 }).notNull(),

  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  // phone: varchar("phone", { length: 10 }).notNull(),

  softDeleted: boolean("soft_deleted").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
module.exports = { user };
