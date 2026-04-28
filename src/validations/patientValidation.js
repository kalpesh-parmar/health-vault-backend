const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");
const { genderTypeValue } = require("../enums/genderType");
const { userStatusValues } = require("../enums/userStatus.enum");

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const uppercaseRegex = /[A-Z]/;
const lowercaseRegex = /[a-z]/;
const numberRegex = /[0-9]/;
const symbolRegex = /[@$!%*?&]/;
const alphabetsRegex = /^[A-Za-z\s]+$/;

function calculateAge(dateOfBirth) {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1;
  }

  return age;
}

const nameField = (requiredError) =>
  z
    .string({ required_error: requiredError })
    .trim()
    .min(2, errorConstants.NAME_TOO_SHORT)
    .max(255, errorConstants.NAME_TOO_LONG)
    .regex(alphabetsRegex, errorConstants.ONLY_ALPHABETS);

const emailField = z
  .string({ required_error: errorConstants.EMAIL_REQUIRED })
  .trim()
  .min(8, errorConstants.EMAIL_TOO_SHORT)
  .max(255, errorConstants.EMAIL_TOO_LONG)
  .regex(emailRegex, errorConstants.VALID_EMAIL_REQUIRED)
  .toLowerCase();

const passwordField = z
  .string({ required_error: errorConstants.PASSWORD_REQUIRED })
  .trim()
  .min(8, errorConstants.PASSWORD_TOO_SHORT)
  .max(64, errorConstants.PASSWORD_TOO_LONG)
  .refine((value) => uppercaseRegex.test(value), errorConstants.PASSWORD_UPPERCASE_REQUIRED)
  .refine((value) => lowercaseRegex.test(value), errorConstants.PASSWORD_LOWERCASE_REQUIRED)
  .refine((value) => numberRegex.test(value), errorConstants.PASSWORD_NUMBER_REQUIRED)
  .refine((value) => symbolRegex.test(value), errorConstants.PASSWORD_SYMBOL_REQUIRED);

const dateOfBirthField = z.coerce.date({
  invalid_type_error: errorConstants.DATE_OF_BIRTH_REQUIRED,
  required_error: errorConstants.DATE_OF_BIRTH_REQUIRED,
});

const phoneField = z
  .string({ required_error: errorConstants.PHONE_REQUIRED })
  .regex(/^\d{10}$/, errorConstants.PHONE_INVALID);

const createPatientSchema = z
  .object({
    dateOfBirth: dateOfBirthField,
    email: emailField,
    fullName: nameField(errorConstants.FULL_NAME_REQUIRED),
    gender: z.enum(genderTypeValue, {
      invalid_type_error: errorConstants.GENDER_INVALID,
      required_error: errorConstants.GENDER_INVALID,
    }),
    password: passwordField,
    phone: phoneField,
    profileImageKey: z.string().trim().max(500).optional().nullable(),
    userName: nameField(errorConstants.USER_NAME_REQUIRED),
  })
  .strict()
  .transform((data) => ({
    ...data,
    age: calculateAge(data.dateOfBirth),
  }));

const updatePatientSchema = z
  .object({
    dateOfBirth: dateOfBirthField.optional(),
    email: emailField.optional(),
    fullName: nameField(errorConstants.FULL_NAME_REQUIRED).optional(),
    gender: z.enum(genderTypeValue).optional(),
    password: passwordField.optional(),
    phone: phoneField.optional(),
    profileImageKey: z.string().trim().max(500).optional().nullable(),
    status: z.enum(userStatusValues).optional(),
    userName: nameField(errorConstants.USER_NAME_REQUIRED).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, errorConstants.INVALID_REQUEST)
  .transform((data) => {
    if (!data.dateOfBirth) {
      return data;
    }

    return {
      ...data,
      age: calculateAge(data.dateOfBirth),
    };
  });

const loginPatientSchema = z
  .object({
    deviceToken: z.string().max(500).optional().nullable(),
    email: emailField,
    password: passwordField,
  })
  .strict();

const refreshTokenSchema = z
  .object({
    refreshToken: z.string({ required_error: errorConstants.REFRESH_TOKEN_REQUIRED }).min(1),
  })
  .strict();

const emailOnlySchema = z
  .object({
    email: emailField,
  })
  .strict();

const verifyOtpSchema = z
  .object({
    email: emailField,
    otp: z.string().trim().length(6, errorConstants.INVALID_OTP),
  })
  .strict();

const resetPasswordSchema = z
  .object({
    email: emailField,
    password: passwordField,
  })
  .strict();

const listPatientsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(10),
    page: z.coerce.number().int().positive().default(1),
    search: z.string().trim().optional(),
    sortBy: z.string().trim().default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    status: z.enum(userStatusValues).optional(),
  })
  .strict()
  .transform((data) => ({
    ...data,
    offset: (data.page - 1) * data.limit,
  }));

module.exports = {
  createPatientSchema,
  emailOnlySchema,
  listPatientsQuerySchema,
  loginPatientSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  updatePatientSchema,
  verifyOtpSchema,
};
