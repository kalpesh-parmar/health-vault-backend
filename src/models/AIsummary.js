const { uuid, boolean, pgTable, timestamp } = require("drizzle-orm/pg-core");
const { patient } = require("./patient");
const { jsonb } = require("drizzle-orm/pg-core");
const { text } = require("drizzle-orm/pg-core");
const AIsummary = pgTable("AI_Summary", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => patient.id, { onDelete: "cascade" }),
  Message: text("user_message"),
  aiSummaryData: jsonb("AI_summary_data"),
  softDelete: boolean("soft_delete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
module.exports = { AIsummary };
