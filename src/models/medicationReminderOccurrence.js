const {
  pgTable,
  uuid,
  timestamp,
  varchar,
  boolean,
  pgEnum,
  integer,
  index,
} = require("drizzle-orm/pg-core");

const { medicationReminder } = require("./medicationReminder");

const { reminderTypeValues } = require("../enums/reminderType");

const { reminderOccurrenceStatusValues } = require("../enums/reminderOccurrenceStatus");

const reminderTypeEnum = pgEnum("occurrence_type", reminderTypeValues);

const occurrenceStatusEnum = pgEnum("occurrence_status", reminderOccurrenceStatusValues);

const medicationReminderOccurrence = pgTable(
  "medication_reminder_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    reminderId: uuid("reminder_id")
      .references(() => medicationReminder.id, {
        onDelete: "cascade",
      })
      .notNull(),

    type: reminderTypeEnum("type").notNull(),

    status: occurrenceStatusEnum("status").default("PENDING").notNull(),

    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
    }).notNull(),

    actualMedicationTime: timestamp("actual_medication_time", {
      withTimezone: true,
    }),

    notificationSent: boolean("notification_sent").default(false).notNull(),

    notificationSentAt: timestamp("notification_sent_at", {
      withTimezone: true,
    }),

    completedAt: timestamp("completed_at", {
      withTimezone: true,
    }),

    skippedAt: timestamp("skipped_at", {
      withTimezone: true,
    }),

    missedAt: timestamp("missed_at", {
      withTimezone: true,
    }),

    snoozeUntil: timestamp("snooze_until", {
      withTimezone: true,
    }),

    snoozeCount: integer("snooze_count").default(0).notNull(),

    responseMessage: varchar("response_message", {
      length: 500,
    }),

    quantityConsumed: integer("quantity_consumed").default(0),

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

    index("occurrence_status_idx").on(table.status),

    index("occurrence_schedule_idx").on(table.scheduledAt),
  ],
);

module.exports = {
  medicationReminderOccurrence,
  occurrenceStatusEnum,
  reminderTypeEnum,
};
