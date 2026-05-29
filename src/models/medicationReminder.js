const { pgTable, uuid, timestamp, integer, boolean, index, json } = require("drizzle-orm/pg-core");
const { medication } = require("./medication");
const { patient } = require("./patient");
const { frequencyType } = require("../enums/frequencyType");
const { pgEnum } = require("drizzle-orm/pg-core");
const frequencyTypeEnum = pgEnum("frequency", frequencyType);
const medicationReminder = pgTable(
  "medication_reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    patientId: uuid("patient_id")
      .references(() => patient.id, {
        onDelete: "cascade",
      })
      .notNull(),

    medicationId: uuid("medication_id")
      .references(() => medication.id, {
        onDelete: "cascade",
      })
      .notNull(),

    reminderBeforeMinutes: integer("reminder_before_minutes").default(5).notNull(),

    afterReminderMinutes: integer("after_reminder_minutes").default(10).notNull(),

    refillAlertBeforeDays: integer("refill_alert_before_days").default(2).notNull(),

    dosePerIntake: integer("dose_per_intake"),

    routineBase: frequencyTypeEnum("frequency").default(frequencyType.ONCE_DAILY).notNull(),

    medicationTime: json("medication_times"),

    active: boolean("active").default(true).notNull(),

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
    index("medication_reminders_patient_idx").on(table.patientId),
    index("medication_reminders_medication_idx").on(table.medicationId),
  ],
);

module.exports = {
  medicationReminder,
  frequencyTypeEnum
};
