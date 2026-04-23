const { z } = require("zod");
const messageConstant = require("../constant/messageConstant");
const { genderValues } = require("../enumData/genderEnum");

const genderZod = z.enum(genderValues,messageConstant.INVALID_GENDER);
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const UPPER_REGEX = /[A-Z]/;
const LOWER_CASE = /[a-z]/;
const NUMBER = /[0-9]/;
const SYMBOL = /[@$!%*?&]/;
const ALPHABETS = /^[A-Za-z\s]+$/s;


const nameField = z
  .string(messageConstant.NAME_REQUIRED)
  .trim()
  .min(2, messageConstant.NAME_TOO_SHORT)
  .max(255, messageConstant.NAME_TOO_LONG)
  .regex(ALPHABETS, messageConstant.ONLY_ALPHABETS);

const email = z
  .string(messageConstant.EMAIL_REQUIRED)
  .email(messageConstant.VALID_EMAIL)
  .trim()
  .min(8, messageConstant.EMAIL_TOO_SHORT)
  .max(255, messageConstant.EMAIL_TOO_LONG)
  .regex(emailRegex, messageConstant.VALID_EMAIL);

const password = z
  .string(messageConstant.PASSWORD_REQUIRED)
  .trim()
  .min(8, messageConstant.PASSWORD_TOO_SHORT)
  .max(64, messageConstant.PASSWORD_TOO_LONG)
  .refine((val) => UPPER_REGEX.test(val), messageConstant.MUST_UPPER)
  .refine((val) => LOWER_CASE.test(val), messageConstant.MUST_LOWER)
  .refine((val) => NUMBER.test(val), messageConstant.MUST_NUM)
  .refine((val) => SYMBOL.test(val), messageConstant.MUST_SYMBOL);

  const patientCode= z.string().optional();
const dateOfBirth = z.coerce.date();
const phone = z
  .string(messageConstant.PHONE_NUMBER_REQUIRED)
  .regex(/^\d{10}$/, messageConstant.PHONE_NUMBER_MUST_BE_10_DIGITS);


function calculateAge(dob) {
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }
  return age;
}


const userSchema = z
  .object({
    patientCode:patientCode,
    userName: nameField,
    fullName: nameField,
    email: email,
    password: password,
    gender:genderZod,
    dateOfBirth: dateOfBirth,
    phone: phone,
  })
  .transform((data) => {
    try {
      return {
        ...data,
        age: calculateAge(data.dateOfBirth),
      };
    } catch (err) {
      throw new Error("Age calculation failed ");
    }
  });
//updated user schema for update operation
const updateUserSchema = z.object({
  userName: nameField.optional(),
  password: password.optional(),
  email: email.optional(),
});
const loginUserSchema = z.object({
  email: email,
  password: password,
});

module.exports = { userSchema, updateUserSchema, loginUserSchema };
