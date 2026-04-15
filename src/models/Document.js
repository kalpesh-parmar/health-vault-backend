const {
  integer,
  pgTable,
  varchar,
  serial,
  timestamp,
  boolean,
} = require("drizzle-orm/pg-core");
const { user } = require("./User");

const document = pgTable("documents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.id),

  title: varchar("title", { length: 255 }),

  softDelete: boolean("soft_delete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { document };
