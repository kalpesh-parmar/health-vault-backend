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
  date,
  text,
} = require("drizzle-orm/pg-core");

const { genderTypeValue } = require("../enums/genderType");
const { providerValues } = require("../enums/providerType");
const { USER_STATUS, userStatusValues } = require("../enums/userStatus.enum");

const genderEnum = pgEnum("gender", genderTypeValue);
const userStatusEnum = pgEnum("user_status", userStatusValues);
const providerEnum = pgEnum("provider", providerValues);
const patient = pgTable(
  "patients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    patientCode: varchar("patient_code", { length: 32 }).notNull().unique(),
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    fullName: varchar("full_name", { length: 255 }),
    email: varchar("email", { length: 255 }).unique(),
    password: varchar("password", { length: 255 }),
    status: userStatusEnum("status").default(USER_STATUS.ACTIVE).notNull(),
    loginAttempts: integer("login_attempts").default(0).notNull(),
    blockedAt: timestamp("blocked_at"),
    otp: varchar("otp", { length: 10 }),
    otpSendDateTime: timestamp("otp_send_date_time"),
    otpExpiredDateTime: timestamp("otp_expired_date_time"),
    isVerified: boolean("is_verified").default(false).notNull(),
    otpVerifiedAt: timestamp("otp_verified_at"),
    gender: genderEnum("gender"),

    // Phone authentication fields
    mobile: varchar("mobile", { length: 20 }),
    countryCode: varchar("country_code", { length: 10 }),
    firebaseUid: varchar("firebase_uid", { length: 255 }),
    isActive: boolean("is_active").default(true).notNull(),
    lastLoginAt: timestamp("last_login_at"),

    // Support DOB, Age, allergies, bloodGroup from both branches
    dateOfBirth: date("date_of_birth", { mode: "date" }),
    profileImageKey: text("profile_image_key"),
    bloodGroup: varchar("blood_group", { length: 8 }),
    allergies: text("allergies").array(),
    provider: providerEnum("provider"),
    providerId: integer("provider_id"),
    softDelete: boolean("soft_delete").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("patients_email_unique_idx").on(table.email),
    uniqueIndex("patients_code_unique_idx").on(table.patientCode),
    uniqueIndex("patients_mobile_unique_idx").on(table.mobile),
    uniqueIndex("patients_firebase_uid_unique_idx").on(table.firebaseUid),
    index("patients_status_idx").on(table.status),
    index("patients_soft_delete_idx").on(table.softDelete),
    index("patients_email_idx").on(table.email),
    index("patients_full_name_idx").on(table.fullName),
    index("patients_mobile_idx").on(table.mobile),
    index("patients_created_at_idx").on(table.createdAt),
  ],
);

module.exports = {
  patient,
  userStatusEnum,
  genderEnum,
  providerEnum,
};
