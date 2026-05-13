const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");
const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenValues } = require("../enums/bestTakenType");

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
      .min(1, errorConstants.ONE_REQUIRED),

    bestTaken: z.array(z.enum(bestTakenValues)).min(1, errorConstants.ONE_REQUIRED).optional(),

    withFood: z.enum(foodTypeValues).optional(),

    startDate: dateField,

    endDate: dateField.optional().nullable(),

    ongoing: z.boolean().default(false),

    totalPills: z
      .number({
        required_error: errorConstants.TOTAL_PILLS_REQUIRED,
      })
      .int()
      .min(0, errorConstants.NOT_NEGATIVE),

    doseReminders: z.boolean().default(false),

    refillAlert: z.boolean().default(false),

    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.totalPills !== undefined && data.dosePerIntake > data.totalPills) {
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
  });

//UPDATE SCHEMA
const updateMedicationSchema = z
  .object({
    medicationName: medicationNameField.optional(),

    medicationType: z.enum(medicationTypeValues).optional(),

    prescribedBy: prescribedByField,

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

    bestTaken: z.array(z.enum(bestTakenValues)).optional(),

    withFood: z.enum(foodTypeValues).optional(),

    startDate: dateField.optional(),

    ongoing: z.boolean().optional(),

    totalPills: z.number().int().min(0).optional(),

    doseReminders: z.boolean().optional(),

    remainingPills: z.number().int().min(0).optional(),

    refillAlert: z.boolean().optional(),

    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

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

module.exports = {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
};
