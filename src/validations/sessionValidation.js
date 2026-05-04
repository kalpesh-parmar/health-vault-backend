const { z } = require("zod");

const createSessionSchema = z
  .object({
    deviceToken: z.string().max(500).optional().nullable(),
  })
  .strict();

module.exports = { createSessionSchema };
