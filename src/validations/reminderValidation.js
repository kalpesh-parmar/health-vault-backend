const { z } = require("zod");
const {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
} = require("../enums/reminderOccurrenceStatus");

const createReminderSchema = z
  .object({
    medicationId: z.string().uuid(),
    active: z.boolean().optional(),
  })
  .strict();

const updateOccurrenceSchema = z
  .object({
    status: z.literal(reminderOccurrenceStatus.COMPLETED).optional(),
  })
  .strict();

const listOccurrencesQuerySchema = z
  .object({
    filter: z
      .object({
        status: z.enum(reminderOccurrenceStatusValues).optional(),
        startDate: z.string().trim().optional(),
        endDate: z.string().trim().optional(),
        medicationName: z.string().trim().optional(),
        medicationType: z.string().trim().optional(),
        isOverdue: z.boolean().optional(),
      })
      .optional(),

    sort: z
      .object({
        sortBy: z
          .enum(["actualMedicationTime", "completedAt", "createdAt", "status"])
          .default("actualMedicationTime"),

        sortOrder: z.enum(["asc", "desc"]).default("asc"),
      })
      .optional(),

    page: z
      .object({
        pageNumber: z.coerce.number().int().min(1).default(1),

        pageLimit: z.coerce.number().int().min(1).max(100).default(10),
      })
      .optional(),
  })
  .strict();

module.exports = {
  createReminderSchema,
  updateOccurrenceSchema,
  listOccurrencesQuerySchema,
};
