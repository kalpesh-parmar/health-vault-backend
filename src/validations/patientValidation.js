const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");
const { genderTypeValue } = require("../enums/genderType");
const { userStatusValues } = require("../enums/userStatus.enum");
// const { provider } = require("../services/objectStorageService");
const { providerValues } = require("../enums/providerType");
const { loginTypeValues } = require("../enums/loginType.enum");

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const uppercaseRegex = /[A-Z]/;
const lowercaseRegex = /[a-z]/;
const numberRegex = /[0-9]/;
const symbolRegex = /[@$!%*?&]/;
const alphabetsRegex = /^[A-Za-z\s]+$/;

const { getAgeFromDateOfBirth } = require("../helpers/dateHelper");

function calculateAge(dateOfBirth) {
  return getAgeFromDateOfBirth(dateOfBirth);
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

const dateOfBirthField = z.coerce
  .date({
    invalid_type_error: errorConstants.DATE_OF_BIRTH_REQUIRED,
    required_error: errorConstants.DATE_OF_BIRTH_REQUIRED,
  })
  .max(new Date(), errorConstants.CANT_BE_FUTURE_DATE);

const mobileField = z
  .string({ required_error: errorConstants.PHONE_REQUIRED })
  .regex(/^\d{10}$/, errorConstants.PHONE_INVALID);

const profileImageKey = z.string().trim().max(500).optional().nullable();

const allergiesField = z.preprocess((val) => {
  if (typeof val === "string") {
    return val
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return val;
}, z.array(z.string()).optional().nullable());

const createPatientSchema = z
  .object({
    dateOfBirth: dateOfBirthField.optional(),
    email: emailField,
    firstName: nameField(errorConstants.FIRST_NAME_REQUIRED),
    lastName: nameField(errorConstants.LAST_NAME_REQUIRED),
    // fullName: nameField(errorConstants.FULL_NAME_REQUIRED),
    gender: z.enum(genderTypeValue, {
      invalid_type_error: errorConstants.GENDER_INVALID,
      required_error: errorConstants.GENDER_INVALID,
    }),
    password: passwordField,
    mobile: mobileField,
    profileImageKey: profileImageKey,
    allergies: allergiesField,
    bloodGroup: z.string().trim().optional().nullable(),
  })
  .strict()
  .transform((data) => {
    return {
      ...data,
      fullName: `${data.firstName} ${data.lastName}`,
    };
  });

const updatePatientSchema = z
  .object({
    dateOfBirth: dateOfBirthField.optional(),
    email: emailField.optional(),
    firstName: nameField(errorConstants.FIRST_NAME_REQUIRED).optional(),
    lastName: nameField(errorConstants.LAST_NAME_REQUIRED).optional(),
    gender: z.enum(genderTypeValue).optional(),
    password: passwordField.optional(),
    mobile: mobileField.optional(),
    profileImageKey: profileImageKey,
    status: z.enum(userStatusValues).optional(),
    allergies: allergiesField,
    bloodGroup: z.string().trim().optional().nullable(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, errorConstants.INVALID_REQUEST)
  .transform((data) => {
    const updatedData = { ...data };
    if (data.firstName && data.lastName) {
      updatedData.fullName = `${data.firstName} ${data.lastName}`;
    }
    return updatedData;
  });

const socialLogin = z
  .object({
    deviceToken: z.string().max(500).optional().nullable(),
    loginType: z.enum(loginTypeValues),
    provider: z.enum(providerValues),
    providerType: z.string().optional(),
    providerToken: z.string().optional(),
    firebaseIdToken: z.string().min(1).optional(),
    email: z.string().email().max(255).optional().nullable(),
    firstName: z.string().max(100).optional().nullable(),
    lastName: z.string().max(100).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.loginType === "mobile" && data.provider !== "mobile") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider must be mobile when login type is mobile",
        path: ["provider"],
      });
    }
    if (
      data.loginType === "social" &&
      !["google", "facebook", "apple", "microsoft"].includes(data.provider)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider must be google, facebook, apple, or microsoft when login type is social",
        path: ["provider"],
      });
    }
  });

const authFailureSchema = z.object({
  identifier: z.string().optional(),
  provider: z.enum(providerValues),
  loginType: z.enum(loginTypeValues),
});

const refreshTokenSchema = z
  .object({
    refreshToken: z.string({ required_error: errorConstants.REFRESH_TOKEN_REQUIRED }).min(1),
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
  listPatientsQuerySchema,
  refreshTokenSchema,
  updatePatientSchema,
  calculateAge,
  socialLogin,
  authFailureSchema,
};
