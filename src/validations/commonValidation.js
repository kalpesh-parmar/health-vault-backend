const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");

const idParamSchema = z
  .object({
    id: z.string().uuid(errorConstants.ID_INVALID),
  })
  .strict();

const paginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(10),
    page: z.coerce.number().int().positive().default(1),
    search: z.string().trim().optional(),
    sortBy: z.string().trim().default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .transform((data) => ({
    ...data,
    offset: (data.page - 1) * data.limit,
  }));

const emptySchema = z.object({}).strict();

module.exports = {
  emptySchema,
  idParamSchema,
  paginationQuerySchema,
};
