const {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  date,
  json,

  uuid,
  varchar,
} = require("drizzle-orm/pg-core");

const { medicationTypeValues } = require("../enums/medicationType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { foodTypeValues } = require("../enums/foodType");
const medicationTypeEnum = pgEnum("medication_type", medicationTypeValues);
const frequencyEnum = pgEnum("frequency_type", frequencyTypeValues);
const foodEnum = pgEnum("food_type", foodTypeValues);
const { patient } = require("./patient");

const medication = pgTable(
  "medications",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, {
        onDelete: "cascade",
      }),

    patientCode: varchar("patient_code", {
      length: 32,
    }).notNull(),

    medicationName: varchar("medication_name", {
      length: 255,
    }).notNull(),

    medicationType: medicationTypeEnum("medication_type").notNull(),

    prescribedBy: varchar("prescribed_by", {
      length: 255,
    }),

    dosePerIntake: integer("dose_per_intake"),

    frequency: frequencyEnum("frequency").notNull(),

    medicationTime: json("medication_times"),
    bestTaken: varchar("best_taken", {
      length: 50,
    }).array(),

    foodFrequency: foodEnum("food_frequency"),

    startDate: date("start_date").notNull(),

    endDate: date("end_date"),

    ongoing: boolean("ongoing").default(false).notNull(),

    totalQuantity: integer("total_quantity").default(0),

    remainingQuantity: integer("remaining_quantity").default(0),

    doseReminders: boolean("dose_reminders").default(false),

    unit: varchar("unit", {
      length: 20,
    }).notNull(),

    dailyConsumption: integer("daily_consumption").default(0).notNull(),

    refillAlert: boolean("refill_alert").default(false),

    reminderBeforeMinutes: integer("reminder_before_minutes").default(5).notNull(),

    notes: varchar("notes", {
      length: 1000,
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),

    updatedAt: timestamp("updated_at").defaultNow().notNull(),

    softDelete: boolean("soft_delete").default(false).notNull(),
  },

  (table) => [
    index("medications_patient_code_idx").on(table.patientCode),

    index("medications_name_idx").on(table.medicationName),

    index("medications_start_date_idx").on(table.startDate),
  ],
);

module.exports = {
  medication,
  medicationTypeEnum,
  frequencyEnum,
  foodEnum,
};
