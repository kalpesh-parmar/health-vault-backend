const { z } = require("zod");

const createSessionSchema = z.object({
  userId: z.number(),
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
