const { pgTable, uuid, timestamp, boolean, pgEnum, index } = require("drizzle-orm/pg-core");
const { patient } = require("./patient");
const { medicationReminder } = require("./medicationReminder");
const {
  reminderOccurrenceStatusValues,
  reminderOccurrenceStatus,
} = require("../enums/reminderOccurrenceStatus");
const occurrenceStatusEnum = pgEnum("occurrence_status", reminderOccurrenceStatusValues);
const { medication } = require("./medication");
const medicationReminderOccurrence = pgTable(
  "medication_reminder_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    reminderId: uuid("reminder_id")
      .references(() => medicationReminder.id, {
        onDelete: "cascade",
      })
      .notNull(),

    medicationId: uuid("medication_id")
      .references(() => medication.id, {
        onDelete: "cascade",
      })
      .notNull(),

    patientId: uuid("patient_id")
      .references(() => patient.id, {
        onDelete: "cascade",
      })
      .notNull(),

    status: occurrenceStatusEnum("status").default(reminderOccurrenceStatus.PENDING).notNull(),

    actualMedicationTime: timestamp("actual_medication_time").notNull(),

    beforeReminderTime: timestamp("before_reminder_time"),

    afterReminderTime: timestamp("after_reminder_time"),

    notificationSent: boolean("notification_sent").default(false).notNull(),

    notificationSentAt: timestamp("notification_sent_at"),

    completedAt: timestamp("completed_at"),

    isFollowUp: boolean("is_follow_up").default(false),

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

  (table) => [
    index("occurrence_reminder_idx").on(table.reminderId),

    index("medication_reminder_occurrences_patient_id_idx").on(table.patientId),

    index("occurrence_medication_idx").on(table.medicationId),

    index("occurrence_status_idx").on(table.status),

    index("before_reminder_idx").on(table.beforeReminderTime),

    index("after_reminder_idx").on(table.afterReminderTime),
  ],
);

module.exports = {
  medicationReminderOccurrence,
  occurrenceStatusEnum,
};
