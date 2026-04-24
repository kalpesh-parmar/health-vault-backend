const {
  serial,
  pgTable,
  integer,
  varchar,
  timestamp,
  boolean,
  date
} = require("drizzle-orm/pg-core");
const { genderEnum } = require("../enumData/genderEnum");

const Patient = pgTable("patient", {
  id: serial("id").primaryKey(),
  patientCode: varchar("patient_code", { length: 50 }).notNull().unique(),
  userName: varchar("user_name", { length: 255 }).notNull(),
  fullName: varchar("full_name",{length:255}).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  gender: genderEnum("gender").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  age: integer("age").notNull(),
  phone: varchar("phone", { length: 10 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  softDelete: boolean("soft_delete").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
module.exports ={ Patient};