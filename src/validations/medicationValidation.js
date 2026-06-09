const { z } = require("zod");
const { errorConstants } = require("../constants/errorConstants");
const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenValues, bestTakenType } = require("../enums/bestTakenType");
// const { mediactionUnitValues } = require("../enums/medicationUnit");

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
const periodMap = {
  MORNING: "AM",
  NOON: "PM",
  NIGHT: "PM",
};

//comman validation function
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

  // Validate schedule count based on frequency
  if (allowedCount && data.medicationSchedule && data.medicationSchedule.length > allowedCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["medicationSchedule"],
      message: `Maximum ${allowedCount} medication times allowed for ${data.frequency}`,
    });
  }

  if (data.medicationSchedule?.length) {
    // CUSTOM can appear only once
    const customCount = data.medicationSchedule.filter(
      (item) => item.bestTaken === bestTakenType.CUSTOM,
    ).length;

    if (customCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["medicationSchedule"],
        message: errorConstants.CUSTOM_ONLY_ONCE,
      });
    }

    // Validate bestTaken ↔ period mapping
    data.medicationSchedule.forEach((item, index) => {
      if (item.bestTaken !== bestTakenType.CUSTOM && periodMap[item.bestTaken] !== item.period) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["medicationSchedule", index, "period"],
          message: `${item.bestTaken} requires ${periodMap[item.bestTaken]} period`,
        });
      }
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
    // medicationTime: z
    //   .array(
    //     z.object({
    //       time: z.string({
    //         required_error: errorConstants.TIME_REQUIRED,
    //       }),
    //       period: z.enum(["AM", "PM"], {
    //         required_error: errorConstants.PERIOD_REQUIRED,
    //       }),
    //     }),
    //   )
    //   .min(1, errorConstants.ONE_REQUIRED),
    // bestTaken: z.array(z.enum(bestTakenValues)).min(1, errorConstants.ONE_REQUIRED).optional(),
    medicationSchedule: z
      .array(
        z.object({
          time: z.string({
            required_error: errorConstants.TIME_REQUIRED,
          }),
          period: z.enum(["AM", "PM"], {
            required_error: errorConstants.PERIOD_REQUIRED,
          }),
          bestTaken: z.enum(bestTakenValues),
        }),
      )
      .min(1, errorConstants.ONE_REQUIRED),
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
    // medicationTime: z
    //   .array(
    //     z.object({
    //       time: z.string({
    //         required_error: errorConstants.TIME_REQUIRED,
    //       }),
    //       period: z.enum(["AM", "PM"], {
    //         required_error: errorConstants.PERIOD_REQUIRED,
    //       }),
    //     }),
    //   )
    //   .min(1, errorConstants.ONE_REQUIRED)
    //   .optional(),
    // bestTaken: z.array(z.enum(bestTakenValues)).optional(),
    medicationSchedule: z
      .array(
        z.object({
          time: z.string({
            required_error: errorConstants.TIME_REQUIRED,
          }),
          period: z.enum(["AM", "PM"], {
            required_error: errorConstants.PERIOD_REQUIRED,
          }),
          bestTaken: z.enum(bestTakenValues),
        }),
      )
      .min(1, errorConstants.ONE_REQUIRED)
      .optional(),
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

module.exports = {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  refillMedicationSchema,
};
