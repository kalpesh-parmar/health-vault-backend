const { z } = require("zod");
const messageConstant = require("../constant/messageConstant");
const { findUserByEmail } = require("../repositories/userRepository");

const UPPER_REGEX = /[A-Z]/;
const LOWER_CASE = /[a-z]/;
const NUMBER = /[0-9]/;
const SYMBOL = /[@$!%*?&]/;
const ALPHABETS = /^[A-Za-z\s]+$/s;
// const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// const phoneRegex = /^\+?[0-9]{10,15}$/;
// const passwordRegex =
//   /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const userName = z
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
  .max(255, messageConstant.EMAIL_TOO_LONG);

const password = z
  .string(messageConstant.PASSWORD_REQUIRED)
  .trim()
  .min(8, messageConstant.PASSWORD_TOO_SHORT)
  .max(64, messageConstant.PASSWORD_TOO_LONG)
  .refine((val) => UPPER_REGEX.test(val), messageConstant.MUST_UPPER)
  .refine((val) => LOWER_CASE.test(val), messageConstant.MUST_LOWER)
  .refine((val) => NUMBER.test(val), messageConstant.MUST_NUM)
  .refine((val) => SYMBOL.test(val), messageConstant.MUST_SYMBOL);

const userSchema = z.object({
  userName: userName,
  password: password,
    email: email})
 .refine(async (email) => {
    const user = await findUserByEmail(email);
    return !user;
  }, messageConstant.EMAIL_ALREADY_EXISTS);

//updated user schema for update operation
const updateUserSchema = z.object({
  userName: userName.optional(),
  password: password.optional(),
  email: email.optional(),
});
const loginUserSchema = z.object({
  email: email,
  password: password,
});

module.exports = { userSchema, updateUserSchema, loginUserSchema };
