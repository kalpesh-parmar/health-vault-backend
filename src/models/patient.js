const {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} = require("drizzle-orm/pg-core");

const { genderTypeValue } = require("../enums/genderType");
const { USER_STATUS, userStatusValues } = require("../enums/userStatus.enum");
const { text } = require("drizzle-orm/pg-core");

const genderEnum = pgEnum("gender", genderTypeValue);
const userStatusEnum = pgEnum("user_status", userStatusValues);

const patient = pgTable(
  "patients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    patientCode: varchar("patient_code", { length: 32 }).notNull().unique(),
    userName: varchar("user_name", { length: 255 }).notNull(),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password: varchar("password", { length: 255 }).notNull(),
    status: userStatusEnum("status").default(USER_STATUS.ACTIVE).notNull(),
    loginAttempts: integer("login_attempts").default(0).notNull(),
    blockedAt: timestamp("blocked_at"),
    otp: varchar("otp", { length: 10 }),
    otpSendDateTime: timestamp("otp_send_date_time"),
    otpExpiredDateTime: timestamp("otp_expired_date_time"),
    isVerified: boolean("is_verified").default(false).notNull(),
    otpVerifiedAt: timestamp("otp_verified_at"),
    gender: genderEnum("gender").notNull(),
    // dateOfBirth: date("date_of_birth", { mode: "date" }).notNull(),
    age: integer("age").notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    profileImageKey: text("profile_image_key"),
    s3Key: varchar("s3_key", { length: 500 }),
    softDelete: boolean("soft_delete").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("patients_email_unique_idx").on(table.email),
    uniqueIndex("patients_code_unique_idx").on(table.patientCode),
    index("patients_status_idx").on(table.status),
    index("patients_soft_delete_idx").on(table.softDelete),
    index("patients_email_idx").on(table.email),
    index("patients_full_name_idx").on(table.fullName),
    index("patients_phone_idx").on(table.phone),
    index("patients_created_at_idx").on(table.createdAt),
  ],
);

module.exports = {
  patient,
  userStatusEnum,
};
