const { z } = require("zod");

const MessageConstant = require("../constant/MessageConstant");
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const phoneRegex = /^\+?[0-9]{10,15}$/;
const passwordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const userName = z.string().min(1, MessageConstant.USER_NAME_REQUIRED);
const email = z
  .string()
  .regex(emailRegex, MessageConstant.INVALID_VALID_EMAIL_FORMAT);
const password = z
  .string()
  .min(8)
  .regex(passwordRegex, MessageConstant.INVALID_PASSWORD);

const userSchema = z.object({
  userName: userName,
  email: email,
  password: password,
});

//updated user schema for update operation
const updateUserSchema = z.object({
  userName: userName.optional(),
  email: email.optional(),
  password: password.optional(),
});

module.exports = { userSchema, updateUserSchema };
