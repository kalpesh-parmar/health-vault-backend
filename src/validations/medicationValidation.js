const { z } = require("zod");
const { errorConstants } = require("../constants/errorConstants");
const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenType } = require("../enums/bestTakenType");
// const { mediactionUnitValues } = require("../enums/medicationUnit");

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
    [bestTakenType.MORNING]: time24HourSchema.optional(),
    [bestTakenType.NOON]: time24HourSchema.optional(),
    [bestTakenType.NIGHT]: time24HourSchema.optional(),
    [bestTakenType.CUSTOM]: z.array(time24HourSchema).optional(),
  })
  .refine(
    (data) =>
      !!data.Morning || !!data.Noon || !!data.Night || (data.Custom && data.Custom.length > 0),
    {
      message: errorConstants.ONE_REQUIRED,
    },
  );
const validateMedicationSelections = (data, ctx) => {
  if (!data.frequency || !data.medicationSchedule) {
    return;
  }

  const frequencyLimitMap = {
    ONCE_DAILY: 1,
    TWICE_DAILY: 2,
    THREE_TIMES_DAILY: 3,
  };

  const selectedCount = Object.values(data.medicationSchedule).filter(
    (value) => value !== undefined,
  ).length;
  const allowedCount = frequencyLimitMap[data.frequency];

  if (allowedCount && selectedCount !== allowedCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["medicationSchedule"],
      message: `${data.frequency} requires exactly ${allowedCount} medication time(s)`,
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
    medicationSchedule: medicationScheduleSchema,
    foodFrequency: z.enum(foodTypeValues).optional(),
    startDate: dateField,
    endDate: dateField.optional().nullable(),
    ongoing: z.boolean().default(false),
    totalQuantity: z
      .number({
        required_error: errorConstants.TOTAL_PILLS_REQUIRED,
      })
      .int()
      .min(0, errorConstants.NOT_NEGATIVE),
    reminderBeforeMinutes: z
      .number({
        invalid_type_error: errorConstants.INVALID_NUMBER,
      })
      .int()
      .optional()
      .nullable(),
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

//update schema
const updateMedicationSchema = z
  .object({
    medicationName: medicationNameField.optional(),
    medicationType: z.enum(medicationTypeValues).optional(),
    prescribedBy: prescribedByField,
    dosePerIntake: doseField.optional(),
    frequency: z.enum(frequencyTypeValues).optional(),
    medicationSchedule: medicationScheduleSchema.optional(),
    foodFrequency: z.enum(foodTypeValues).optional(),
    startDate: dateField.optional(),
    ongoing: z.boolean().optional(),
    totalQuantity: z.number().int().min(0).optional(),
    reminderBeforeMinutes: z
      .number({
        invalid_type_error: errorConstants.INVALID_NUMBER,
      })
      .int()
      .optional(),
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

const medicationOnboardingSchema = z
  .object({
    name: z.string().trim().min(1),
    type: z.enum(["TABLET", "CAPSULE", "SYRUP", "INJECTION", "DROPS", "SPRAY", "INHALER"]),
    frequency: z.enum(["ONCE", "TWICE", "THRICE"]),
    dose: z.object({
      count: z.number().optional(),
      value: z.number().optional(),
      unit: z.string().optional(),
    }),
    notes: z.string().trim().optional().nullable(),
    prescribed_by: z.string().trim().optional().nullable(),
    refill_alert: z.boolean().optional(),
    total_quantity: z.number().int().min(0).optional().nullable(),
    client_med_id: z.string().min(1),
    source: z.enum(["OCR", "MANUAL"]).optional().default("MANUAL"),
  })
  .superRefine((data, ctx) => {
    const { type, dose } = data;

    if (type === "TABLET") {
      if (dose.count === undefined || dose.count <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dose", "count"],
          message: "Count must be a positive number for tablets",
        });
      } else {
        const remainder = dose.count % 0.25;
        if (Math.abs(remainder) > 0.0001 && Math.abs(remainder - 0.25) > 0.0001) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dose", "count"],
            message: "Tablet count must be in increments of 0.25",
          });
        }
      }
    } else if (type === "CAPSULE") {
      if (dose.count === undefined || dose.count <= 0 || !Number.isInteger(dose.count)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dose", "count"],
          message: "Capsule count must be a positive whole number (integer)",
        });
      }
    } else {
      if (dose.value === undefined || dose.value <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dose", "value"],
          message: "Dose value must be a positive number",
        });
      }

      if (
        (type === "SPRAY" || type === "INHALER") &&
        dose.value !== undefined &&
        !Number.isInteger(dose.value)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dose", "value"],
          message: `${type.toLowerCase()} dose must be a whole number (puffs)`,
        });
      }

      if (!dose.unit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dose", "unit"],
          message: "Unit is required for this medication type",
        });
      } else {
        const allowedUnits = {
          SYRUP: ["ml", "tsp", "tbsp"],
          INJECTION: ["ml", "IU"],
          DROPS: ["drops", "ml"],
          SPRAY: ["puff"],
          INHALER: ["puff"],
        };
        const list = allowedUnits[type] || [];
        if (!list.includes(dose.unit)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dose", "unit"],
            message: `Unit must be one of: ${list.join(", ")}`,
          });
        }
      }
    }
  });

module.exports = {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  refillMedicationSchema,
  medicationOnboardingSchema,
};
