const {
  pgTable,
  uuid,
  timestamp,
  integer,
  varchar,
  boolean,
  pgEnum,
  index,
  json,
} = require("drizzle-orm/pg-core");

const { medication } = require("./medication");
const { patient } = require("./patient");

const {
  reminderTypeValues,
} = require("../enums/reminderType");

const {
  reminderStatusValues,
} = require("../enums/reminderStatus");

const reminderTypeEnum = pgEnum(
  "reminder_type",
  reminderTypeValues
);

const reminderStatusEnum = pgEnum(
  "reminder_status",
  reminderStatusValues
);

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

    type: reminderTypeEnum("type").notNull(),

    status: reminderStatusEnum("status")
      .default("ACTIVE")
      .notNull(),

    reminderBeforeMinutes: integer(
      "reminder_before_minutes"
    )
      .default(5)
      .notNull(),

    afterReminderMinutes: integer(
      "after_reminder_minutes"
    )
      .default(10)
      .notNull(),

    refillAlertBeforeDays: integer(
      "refill_alert_before_days"
    )
      .default(2)
      .notNull(),

    dosePerIntake: integer("dose_per_intake"),

    frequency: varchar("frequency", {
      length: 50,
    }),

    medicationTime: json("medication_times"),

    timezone: varchar("timezone", {
      length: 100,
    })
      .default("Asia/Kolkata")
      .notNull(),

    active: boolean("active")
      .default(true)
      .notNull(),

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

    softDelete: boolean("soft_delete")
      .default(false)
      .notNull(),
  },

  (table) => [
    index("medication_reminders_patient_idx").on(
      table.patientId
    ),

    index("medication_reminders_medication_idx").on(
      table.medicationId
    ),

    index("medication_reminders_type_idx").on(
      table.type
    ),
  ]
);

module.exports = {
  medicationReminder,
  reminderTypeEnum,
  reminderStatusEnum,
};