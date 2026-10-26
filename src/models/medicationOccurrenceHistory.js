const { pgTable, uuid, timestamp, varchar, integer, index } = require("drizzle-orm/pg-core");
const { medicationReminderOccurrence } = require("./medicationReminderOccurrence");
const { patient } = require("./patient");

const medicationOccurrenceHistory = pgTable(
  "medication_occurrence_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurrenceId: uuid("occurrence_id")
      .references(() => medicationReminderOccurrence.id, {
        onDelete: "cascade",
      })
      .notNull(),
    patientId: uuid("patient_id")
      .references(() => patient.id, {
        onDelete: "cascade",
      })
      .notNull(),
    fromStatus: varchar("from_status", { length: 32 }).notNull(),
    toStatus: varchar("to_status", { length: 32 }).notNull(),
    completionClassification: varchar("completion_classification", { length: 32 }),
    actionTimestamp: timestamp("action_timestamp", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
    }),
    delayMinutes: integer("delay_minutes"),
    actor: varchar("actor", { length: 32 }).default("PATIENT").notNull(),
    notes: varchar("notes", { length: 500 }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("med_occ_hist_occurrence_id_idx").on(table.occurrenceId),
    index("med_occ_hist_patient_id_idx").on(table.patientId),
    index("med_occ_hist_action_timestamp_idx").on(table.actionTimestamp),
  ],
);

module.exports = {
  medicationOccurrenceHistory,
};
