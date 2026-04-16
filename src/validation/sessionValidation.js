const { z } = require("zod");

const createSessionSchema = z.object({
  userId: z.number(),
  deviceToken: z.string().min(1),
});

const logoutSchema = z.object({
  sessionId: z.number(),
});

const deleteSchema = z.object({
  sessionId: z.number(),
});

module.exports = {
  createSessionSchema,
  logoutSchema,
  deleteSchema,
};
