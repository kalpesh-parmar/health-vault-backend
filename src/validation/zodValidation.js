const { z } = require("zod");

const MessageConstant = require("../constant/MessageConstant");
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const phoneRegex = /^\+?[0-9]{10,15}$/;
const passwordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const userSchema = z.object({
  userName: z.string().min(1, MessageConstant.USER_NAME_REQUIRED),
  // firstName: z.string().min(1, MessageConstant.FIRST_NAME_REQUIRED),
  // lastName: z.string().min(1, MessageConstant.LAST_NAME_REQUIRED),
  email: z
    .string()
    .regex(emailRegex, MessageConstant.INVALID_VALID_EMAIL_FORMAT),
  password: z
    .string()
    .min(8)
    .regex(passwordRegex, MessageConstant.INVALID_PASSWORD),
  // phone: z.string().regex(phoneRegex, MessageConstant.INVALID_PHONE),
  isDeleted: z.boolean().optional(),
});

// const userSchema = z
//   .object({
//     userName:userName,
//     email: email,
//     password: password,
//     });
module.exports = { userSchema };
