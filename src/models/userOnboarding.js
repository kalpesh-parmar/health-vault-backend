const { pgTable, uuid, integer, jsonb, boolean, timestamp } = require("drizzle-orm/pg-core");
const { patient } = require("./patient");

const userOnboarding = pgTable("user_onboarding", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => patient.id, { onDelete: "cascade" }),
  step: integer("step").default(1).notNull(),
  data: jsonb("data"),
  isCompleted: boolean("is_completed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { userOnboarding };
