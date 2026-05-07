const {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  // uniqueIndex,
  uuid,
  varchar,
} = require("drizzle-orm/pg-core");
const { medicationTypeValues } = require("../enums/medicationType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { foodTypeValues } = require("../enums/foodType");
// const { bestTakenValues } = require("../enums/bestTakenType");

const medicationTypeEnum = pgEnum("medication_type", medicationTypeValues);
const frequencyEnum = pgEnum("frequency_type", frequencyTypeValues);
const foodEnum = pgEnum("food_type", foodTypeValues);
// const bestTakenEnum=pgEnum("best_taken",bestTakenValues)

const { patient } = require("./patient");

const medication = pgTable(
  "medications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    medicationName: varchar("medication_name", { length: 255 }).notNull(),
    medicationType: medicationTypeEnum("medication_type").notNull(),
    prescribedBy: varchar("prescribed_by", { length: 255 }),
    dosePerIntake: varchar("dose_per_intake", { length: 100 }),
    frequency: frequencyEnum("frequency").notNull(),
    bestTaken: varchar("best_taken", { length: 50 }).array(),
    withFood: foodEnum("with_food"),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date"),
    ongoing: boolean("ongoing").default(false).notNull(),
    pillsRemaining: integer("pills_remaining").default(0),
    doseReminders: boolean("dose_reminders").default(false),
    refillAlert: boolean("refill_alert").default(false),
    notes: varchar("notes", { length: 1000 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    softDelete: timestamp("soft_delete").defaultNow().notNull(),
  },

  (table) => [
    index("medications_patient_code_idx").on(table.patientCode),
    index("medications_name_idx").on(table.medicationName),
    index("medications_start_date_idx").on(table.startDate),
  ],
);

module.exports = {
  medication,
};
