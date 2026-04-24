const {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} = require("drizzle-orm/pg-core");
const { User } = require("./patient");

const healthRecords = pgTable("health_records", {
  id: serial("id").primaryKey(),

  userId: integer("user_id")
    .notNull()
    .references(() => User.id, { onDelete: "cascade" }),

  record: text("record"),

  softDelete: boolean("soft_delete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { healthRecords };
