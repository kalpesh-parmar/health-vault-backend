const { z } = require("zod");
const { errorConstants } = require("../constants/errorConstants");
const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenValues, bestTakenType } = require("../enums/bestTakenType");
const { mediactionUnitValues } = require("../enums/medicationUnit");

const time24HourSchema = z
  .string({
    required_error: errorConstants.TIME_REQUIRED,
  })
  .regex(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/, errorConstants.INVALID_TIME);

const medicationNameField = z
  .string({
    required_error: errorConstants.MEDICATION_NAME_REQUIRED,
  })
  .trim()
  .min(2, errorConstants.NAME_SHORT)
  .max(255, errorConstants.NAME_LONG);

const prescribedByField = z
  .string()
  .trim()
  .max(255, errorConstants.NAME_TOO_LONG)
  .optional()
  .nullable();

const doseField = z
  .number({
    required_error: errorConstants.DOSE_REQUIRED,
    invalid_type_error: errorConstants.INVALID_NUMBER,
  })
  .int()
  .positive(errorConstants.DOSE_POSITIVE);

const dateField = z.coerce.date({
  invalid_type_error: errorConstants.INVALID_DATE,
  required_error: errorConstants.DATE_REQUIRED,
});

const validateStartDate = (startDate, ctx) => {
  if (!startDate) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const selectedDate = new Date(startDate);
  selectedDate.setHours(0, 0, 0, 0);

  if (selectedDate < today) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startDate"],
      message: errorConstants.START_DATE_PAST,
    });
  }
};

const medicationScheduleSchema = z
  .object({
    [bestTakenType.MORNING || "MORNING"]: time24HourSchema.optional(),
    [bestTakenType.NOON || "NOON"]: time24HourSchema.optional(),
    [bestTakenType.NIGHT || "NIGHT"]: time24HourSchema.optional(),
    [bestTakenType.CUSTOM || "CUSTOM"]: time24HourSchema.optional(),
  })
  .refine((data) => Object.values(data).some(Boolean), {
    message: errorConstants.ONE_REQUIRED,
  });

const validateMedicationSelections = (data, ctx) => {
  if (!data.frequency) {
    return;
  }

  const frequencyLimitMap = {
    ONCE_DAILY: 1,
    TWICE_DAILY: 2,
    THREE_TIMES_DAILY: 3,
  };

  const allowedCount = frequencyLimitMap[data.frequency];

  // medicationSchedule validation
  if (data.medicationSchedule) {
    const selectedCount = Object.values(data.medicationSchedule).filter(
      (value) => value !== undefined,
    ).length;
    if (allowedCount && selectedCount !== allowedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["medicationSchedule"],
        message: `${data.frequency} requires exactly ${allowedCount} medication time(s)`,
      });
    }
  }

  // medicationTime validation
  if (data.medicationTime && data.medicationTime.length) {
    if (allowedCount && data.medicationTime.length > allowedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["medicationTime"],
        message: `Maximum ${allowedCount} medication times allowed for ${data.frequency}`,
      });
    }
  }

  // best taken validation
  if (Array.isArray(data.bestTaken) && data.bestTaken.length) {
    const customCount = data.bestTaken.filter(
      (value) => value === "CUSTOM" || value === (bestTakenValues && bestTakenValues.CUSTOM),
    ).length;

    // Prevent duplicate CUSTOM
    if (customCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bestTaken"],
        message: errorConstants.CUSTOM_ONLY_ONCE,
      });
    }

    // validation total count based on frequency
    if (allowedCount && data.bestTaken.length > allowedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bestTaken"],
        message: `Maximum ${allowedCount} medication times allowed for ${data.frequency}`,
      });
    }
  }

  // match medicationTime count with bestTaken
  if (
    data.bestTaken &&
    data.medicationTime &&
    data.bestTaken.length !== data.medicationTime.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["medicationTime"],
      message: errorConstants.MEDICATION_TIME_MATCH,
    });
  }
};

//CREATE SCHEMA
const createMedicationSchema = z
  .object({
    medicationName: medicationNameField,
    medicationType: z.enum(medicationTypeValues, {
      required_error: errorConstants.MEDICATION_TYPE_REQUIRED,
      invalid_type_error: errorConstants.INVALID_TYPE,
    }),
    prescribedBy: prescribedByField.optional(),
    dosePerIntake: doseField,
    frequency: z.enum(frequencyTypeValues, {
      required_error: errorConstants.FREQUENCY_REQUIRED,
      invalid_type_error: errorConstants.INVALID_TYPE,
    }),
    medicationTime: z
      .array(
        z.object({
          time: z.string({
            required_error: errorConstants.TIME_REQUIRED,
          }),
          period: z.enum(["AM", "PM"], {
            required_error: errorConstants.PERIOD_REQUIRED,
          }),
        }),
      )
      .min(1, errorConstants.ONE_REQUIRED)
      .optional(),
    bestTaken: z
      .array(z.enum(bestTakenValues || ["MORNING", "NOON", "NIGHT", "CUSTOM"]))
      .min(1, errorConstants.ONE_REQUIRED)
      .optional(),
    medicationSchedule: medicationScheduleSchema.optional(),
    foodFrequency: z.enum(foodTypeValues).optional(),
    startDate: dateField,
    endDate: dateField.optional().nullable(),
    ongoing: z.boolean().default(false),
    unit: z.enum(mediactionUnitValues || ["PILLS", "ML", "DROPS", "UNITS"]).optional(),
    totalQuantity: z
      .number({
        required_error: errorConstants.TOTAL_PILLS_REQUIRED,
      })
      .int()
      .min(0, errorConstants.NOT_NEGATIVE),
    doseReminders: z.boolean().default(false),
    reminderBeforeMinutes: z
      .number({
        invalid_type_error: errorConstants.INVALID_NUMBER,
      })
      .int()
      .optional(),
    refillAlert: z.boolean().default(false),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateStartDate(data.startDate, ctx);

    if (data.totalQuantity !== undefined && data.dosePerIntake > data.totalQuantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dosePerIntake"],
        message: errorConstants.DOSE_GREATER_THAN_PILLS,
      });
    }

    if (!data.ongoing && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);

      if (end < start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: errorConstants.END_DATE_INVALID,
        });
      }
    }

    validateMedicationSelections(data, ctx);
  });

//UPDATE SCHEMA
const updateMedicationSchema = z
  .object({
    medicationName: medicationNameField.optional(),
    medicationType: z.enum(medicationTypeValues).optional(),
    prescribedBy: prescribedByField.optional().nullable(),
    dosePerIntake: doseField.optional(),
    frequency: z.enum(frequencyTypeValues).optional(),
    medicationTime: z
      .array(
        z.object({
          time: z.string({
            required_error: errorConstants.TIME_REQUIRED,
          }),
          period: z.enum(["AM", "PM"], {
            required_error: errorConstants.PERIOD_REQUIRED,
          }),
        }),
      )
      .min(1, errorConstants.ONE_REQUIRED)
      .optional(),
    bestTaken: z
      .array(z.enum(bestTakenValues || ["MORNING", "NOON", "NIGHT", "CUSTOM"]))
      .optional(),
    medicationSchedule: medicationScheduleSchema.optional(),
    foodFrequency: z.enum(foodTypeValues).optional(),
    startDate: dateField.optional(),
    endDate: dateField.optional().nullable(),
    ongoing: z.boolean().optional(),
    totalQuantity: z.number().int().min(0).optional(),
    unit: z.enum(mediactionUnitValues || ["PILLS", "ML", "DROPS", "UNITS"]).optional(),
    doseReminders: z.boolean().optional(),
    reminderBeforeMinutes: z
      .number({
        invalid_type_error: errorConstants.INVALID_NUMBER,
      })
      .int()
      .optional(),
    remainingQuantity: z.number().int().min(0).optional(),
    refillAlert: z.boolean().optional(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateStartDate(data.startDate, ctx);

    if (
      data.totalQuantity !== undefined &&
      data.dosePerIntake !== undefined &&
      data.dosePerIntake > data.totalQuantity
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dosePerIntake"],
        message: errorConstants.DOSE_GREATER_THAN_PILLS,
      });
    }
    validateMedicationSelections(data, ctx);
  });

//LIST QUERY SCHEMA
const listMedicationQuerySchema = z
  .object({
    filter: z
      .object({
        patientCode: z.string().trim().optional(),
        medicationType: z.enum(medicationTypeValues).optional(),
        frequency: z.enum(frequencyTypeValues).optional(),
        search: z.string().trim().optional(),
      })
      .optional(),

    sort: z
      .object({
        sortBy: z
          .enum([
            "createdAt",
            "medicationName",
            "medicationType",
            "frequency",
            "startDate",
            "updatedAt",
          ])
          .default("createdAt"),

        sortOrder: z.enum(["asc", "desc"]).default("desc"),
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

//refill medication
const refillMedicationSchema = z.object({
  quantity: z
    .number({
      required_error: errorConstants.QUANTITY_REQUIRED,
      invalid_type_error: errorConstants.INVALID_NUMBER,
    })
    .int()
    .positive(),
});

module.exports = {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  refillMedicationSchema,
};
