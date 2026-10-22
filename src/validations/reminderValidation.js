const { z } = require("zod");
const {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
} = require("../enums/reminderOccurrenceStatus");

const createReminderSchema = z
  .object({
    medicationId: z.string().uuid(),
  })
  .strict();

const updateOccurrenceSchema = z
  .object({
    status: z
      .enum([
        reminderOccurrenceStatus.COMPLETED,
        reminderOccurrenceStatus.SKIPPED,
        reminderOccurrenceStatus.CANCELLED,
      ])
      .optional(),
    completedAt: z
      .string()
      .datetime({
        offset: true,
        message: "completedAt must be a valid ISO 8601 datetime string",
      })
      .optional(),
    takenAt: z
      .string()
      .datetime({
        offset: true,
        message: "takenAt must be a valid ISO 8601 datetime string",
      })
      .optional(),
    notes: z.string().max(500).optional(),
    skipReason: z.string().max(255).optional(),
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
