const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");

const notificationSortKeys = ["createdAt", "title"];

const notificationFilterSchema = z
  .object({
    isRead: z.boolean().optional(),
    search: z.string().trim().optional(),
    userId: z.string().trim().min(1, errorConstants.INVALID_REQUEST).optional(),
  })
  .strict();

const notificationSortSchema = z
  .object({
    orderBy: z.enum(["asc", "desc"]).default("desc"),
    sortBy: z.enum(notificationSortKeys).default("createdAt"),
  })
  .strict();

const listNotificationsSchema = z
  .object({
    filter: notificationFilterSchema.optional().default({}),
    sort: notificationSortSchema.optional().default({
      orderBy: "desc",
      sortBy: "createdAt",
    }),
  })
  .strict();

const listNotificationsPaginatedSchema = listNotificationsSchema
  .extend({
    page: z
      .object({
        pageLimit: z.coerce.number().int().min(1).max(100),
        pageNumber: z.coerce.number().int().min(0),
      })
      .strict(),
  })
  .strict();

const notificationIdParamSchema = z
  .object({
    id: z.string().uuid(errorConstants.ID_INVALID),
  })
  .strict();

const userIdBodySchema = z
  .object({
    userId: z.string().trim().min(1, errorConstants.INVALID_REQUEST),
  })
  .strict();

const testSendNotificationSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, errorConstants.INVALID_REQUEST)
      .default("This is a test notification."),
    data: z.record(z.string()).optional().nullable(),
    title: z.string().trim().min(1, errorConstants.INVALID_REQUEST).default("Test notification"),
    // userId: z.string().trim().min(1, errorConstants.INVALID_REQUEST),
  })
  .strict();

module.exports = {
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  notificationIdParamSchema,
  testSendNotificationSchema,
  userIdBodySchema,
};
