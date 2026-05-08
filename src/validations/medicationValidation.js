const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");

const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenValues } = require("../enums/bestTakenType");

/* ---------------- COMMON FIELDS ---------------- */

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

const doseField = z.string().trim().max(100, errorConstants.DOSE_LONG).optional().nullable();

const dateField = z.coerce.date({
  invalid_type_error: errorConstants.INVALID_DATE,
  required_error: errorConstants.DATE_REQUIRED,
});

/* ---------------- CREATE SCHEMA ---------------- */

const createMedicationSchema = z
  .object({
    medicationName: medicationNameField,

    medicationType: z.enum(medicationTypeValues, {
      required_error: errorConstants.MEDICATION_TYPE_REQUIRED,
      invalid_type_error: errorConstants.INVALID_TYPE,
    }),

    prescribedBy: prescribedByField,

    dosePerIntake: doseField,

    frequency: z.enum(frequencyTypeValues, {
      required_error: errorConstants.FREQUENCY_REQUIRED,
    }),

    bestTaken: z.array(z.enum(bestTakenValues)).min(1, errorConstants.ONE_REQUIRED).optional(),

    withFood: z.enum(foodTypeValues).optional(),

    startDate: dateField,

    endDate: dateField.optional().nullable(),

    ongoing: z.boolean().default(false),

    pillsRemaining: z.number().int().min(0, errorConstants.NOT_NEGATIVE).optional(),

    doseReminders: z.boolean().default(false),

    refillAlert: z.boolean().default(false),

    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.ongoing && data.endDate) {
        return false;
      }

      return true;
    },
    {
      message: errorConstants.END_DATE_NULL,
      path: ["endDate"],
    },
  )
  .refine(
    (data) => {
      if (!data.ongoing && !data.endDate) {
        return false;
      }

      return true;
    },
    {
      message: errorConstants.END_DATE_REQUIRED,
      path: ["endDate"],
    },
  );

/* ---------------- UPDATE SCHEMA ---------------- */

const updateMedicationSchema = z
  .object({
    medicationName: medicationNameField.optional(),

    medicationType: z.enum(medicationTypeValues).optional(),

    prescribedBy: prescribedByField,

    dosePerIntake: doseField,

    frequency: z.enum(frequencyTypeValues).optional(),

    bestTaken: z.array(z.enum(bestTakenValues)).optional(),

    withFood: z.enum(foodTypeValues).optional(),

    startDate: dateField.optional(),

    endDate: dateField.optional().nullable(),

    ongoing: z.boolean().optional(),

    pillsRemaining: z.number().int().min(0).optional(),

    doseReminders: z.boolean().optional(),

    refillAlert: z.boolean().optional(),

    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

/* ---------------- LIST QUERY SCHEMA ---------------- */

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
