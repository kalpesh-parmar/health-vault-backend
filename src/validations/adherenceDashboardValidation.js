const { z } = require("zod");
const moment = require("moment-timezone");

function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  if (!/^[A-Za-z0-9_/+-]+$/.test(tz)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return moment.tz.zone(tz) !== null;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, { message: "Invalid IANA timezone string" })
  .optional();

const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Date must be in YYYY-MM-DD format" });

const weeklyDashboardQuerySchema = z
  .object({
    timezone: timezoneSchema,
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.optional(),
  })
  .strict();

const monthlyDashboardQuerySchema = z
  .object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    timezone: timezoneSchema,
  })
  .strict();

const dailyDetailsQuerySchema = z
  .object({
    date: dateOnlySchema,
    timezone: timezoneSchema,
  })
  .strict();

const refillsDashboardQuerySchema = z
  .object({
    timezone: timezoneSchema,
  })
  .strict();

module.exports = {
  isValidTimezone,
  weeklyDashboardQuerySchema,
  monthlyDashboardQuerySchema,
  dailyDetailsQuerySchema,
  refillsDashboardQuerySchema,
};
