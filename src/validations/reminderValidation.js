const { z } = require("zod");
const { reminderTypeValues } = require("../enums/reminderType");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
// CREATE REMINDER
const createReminderSchema = z.object({
  medicationId: z.string().uuid(),
  type: z.enum(reminderTypeValues).optional(),
  reminderBeforeMinutes: z.number().int().min(0).default(5),
  afterReminderMinutes: z.number().int().min(1).default(10),
  refillAlertBeforeDays: z.number().int().min(1).default(1),
  active: z.boolean().optional(),
});
// COMPLETE REMINDER
const completeReminderSchema = z.object({
  quantity: z.number().int().min(1),
  status: z.literal(reminderOccurrenceStatus.COMPLETED).default(reminderOccurrenceStatus.COMPLETED),
});
// MISSED REMINDER
const missedReminderSchema = z.object({
  status: z.literal(reminderOccurrenceStatus.MISSED).default(reminderOccurrenceStatus.MISSED),
});

// SKIPPED REMINDER
const skippedReminderSchema = z.object({
  status: z.literal(reminderOccurrenceStatus.SKIPPED).default(reminderOccurrenceStatus.SKIPPED),
});
// SNOOZE REMINDER
const snoozeReminderSchema = z.object({
  minutes: z.number().int().min(1).max(1440).default(10),

  status: z.literal(reminderOccurrenceStatus.SNOOZED).default(reminderOccurrenceStatus.SNOOZED),
});

// COMPLETE REFILL ALERT
const completeRefillAlertSchema = z.object({
  quantity: z.number().int().min(1),
});

// SNOOZE REFILL ALERT
const snoozeRefillAlertSchema = z.object({
  minutes: z.number().int().min(1).max(10080).default(60),
});

module.exports = {
  createReminderSchema,
  completeReminderSchema,
  missedReminderSchema,
  skippedReminderSchema,
  snoozeReminderSchema,
  completeRefillAlertSchema,
  snoozeRefillAlertSchema,
};
