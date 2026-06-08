const { patient } = require("./patient");
const { medication } = require("./medication");
const { pgTable, integer } = require("drizzle-orm/pg-core");
const { uuid } = require("drizzle-orm/pg-core");
const { timestamp } = require("drizzle-orm/pg-core");
const { boolean } = require("drizzle-orm/pg-core");

const refillCount = pgTable(
  "refill_count",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, {
        onDelete: "cascade",
      }),
    medicationId: uuid("medication_id")
      .references(() => medication.id, {
        onDelete: "cascade",
      })
      .notNull(),
    totalQuantity: integer("total_quantity").notNull(),
    refillQuantity: integer("refill_quantity").notNull(),
    remainingQuantity: integer("remaining_quantity").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),

    softDelete: boolean("soft_delete").default(false).notNull(),
  },
  () => [],
);
module.exports = {
  refillCount,
};
