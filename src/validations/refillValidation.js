const { z } = require("zod");
const quantityNumber = z.number().positive();

const listRefillQuerySchema = z.object({
  filter: z
    .object({
      medicationId: z.string().uuid().optional(),
      beforeRefillRemainingQuantity: quantityNumber.optional(),
      afterRefillRemainingQuantity: quantityNumber.optional(),
      beforeRefillTotalQuantity: quantityNumber.optional(),
      afterRefillTotalQuantity: quantityNumber.optional(),
    })
    .optional(),
  page: z
    .object({
      pageNumber: z.coerce.number().int().min(1).default(1),
      pageLimit: z.coerce.number().int().min(1).max(100).default(10),
    })
    .optional(),
  sort: z
    .object({
      sortBy: z.enum(["createdAt", "medicationId"]).default("createdAt"),

      sortOrder: z.enum(["asc", "desc"]).default("desc"),
    })
    .optional(),
});

module.exports = {
  listRefillQuerySchema,
};
