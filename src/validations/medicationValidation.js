const { z } = require("zod");
const { errorConstants } = require("../constants/errorConstants");
const { foodTypeValues } = require("../enums/foodType");
const { frequencyTypeValues, frequencyType } = require("../enums/frequencyType");
const { medicationTypeValues } = require("../enums/medicationType");
const { bestTakenType } = require("../enums/bestTakenType");

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

const medicationTypeField = z.preprocess(
  (val) => (typeof val === "string" ? val.trim().toUpperCase() : val),
  z.enum(medicationTypeValues, {
    required_error: errorConstants.MEDICATION_TYPE_REQUIRED,
    invalid_type_error: errorConstants.INVALID_TYPE,
  }),
);

const frequencyField = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      const upper = trimmed.toUpperCase().replace(/\s+/g, "_");
      if (upper === "ONCE_DAILY" || upper === "ONCE" || upper === "1X_DAILY") {
        return frequencyType.ONCE_DAILY;
      }
      if (upper === "TWICE_DAILY" || upper === "TWICE" || upper === "2X_DAILY") {
        return frequencyType.TWICE_DAILY;
      }
      if (
        upper === "THREE_TIMES_DAILY" ||
        upper === "THRICE_DAILY" ||
        upper === "THRICE" ||
        upper === "3X_DAILY"
      ) {
        return frequencyType.THREE_TIMES_DAILY;
      }
      if (upper === "AS_NEEDED") {
        return frequencyType.AS_NEEDED;
      }
      return trimmed;
    }
    return val;
  },
  z.enum(frequencyTypeValues, {
    required_error: errorConstants.FREQUENCY_REQUIRED,
    invalid_type_error: errorConstants.INVALID_TYPE,
  }),
);

const foodFrequencyField = z.preprocess((val) => {
  if (typeof val === "string") {
    const upper = val.trim().toUpperCase().replace(/\s+/g, "_");
    if (foodTypeValues.includes(upper)) return upper;
    if (upper === "BEFORE_MEAL" || upper === "BEFORE") return "BEFORE_FOOD";
    if (upper === "AFTER_MEAL" || upper === "AFTER") return "AFTER_FOOD";
    if (upper === "WITH_MEAL" || upper === "WITH") return "WITH_FOOD";
    return upper;
  }
  return val;
}, z.enum(foodTypeValues).optional());

const medicationScheduleSchema = z
  .preprocess(
    (val) => {
      let parsedVal = val;
      if (typeof val === "string") {
        try {
          parsedVal = JSON.parse(val);
        } catch {
          // Ignore parsing error, keep as string
        }
      }

      if (Array.isArray(parsedVal)) {
        return parsedVal;
      }

      if (typeof parsedVal === "object" && parsedVal !== null) {
        const newVal = {};
        for (const key of Object.keys(parsedVal)) {
          let normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
          const upperKey = key.toUpperCase();
          if (upperKey.startsWith("CUSTOM")) {
            normalizedKey = bestTakenType.CUSTOM;
          } else if (upperKey === "MORNING") {
            normalizedKey = bestTakenType.MORNING;
          } else if (upperKey === "NOON") {
            normalizedKey = bestTakenType.NOON;
          } else if (upperKey === "NIGHT") {
            normalizedKey = bestTakenType.NIGHT;
          }

          let keyValue = parsedVal[key];

          if (normalizedKey === bestTakenType.CUSTOM) {
            if (typeof keyValue === "string") {
              const trimmed = keyValue.trim();
              if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
                try {
                  const parsedKeyVal = JSON.parse(trimmed);
                  keyValue = Array.isArray(parsedKeyVal) ? parsedKeyVal : [trimmed];
                } catch {
                  keyValue = trimmed.includes(",")
                    ? trimmed.split(",").map((s) => s.trim())
                    : [trimmed];
                }
              } else {
                keyValue = trimmed.includes(",")
                  ? trimmed.split(",").map((s) => s.trim())
                  : [trimmed];
              }
            }
            if (Array.isArray(keyValue)) {
              keyValue = keyValue.flatMap((item) => {
                if (typeof item === "string" && item.includes(",")) {
                  return item
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                }
                return typeof item === "string" ? item.trim() : item;
              });
            }
          }

          newVal[normalizedKey] = keyValue;
        }
        return newVal;
      }
      return parsedVal;
    },
    z.object({
      [bestTakenType.MORNING]: time24HourSchema.optional(),
      [bestTakenType.NOON]: time24HourSchema.optional(),
      [bestTakenType.NIGHT]: time24HourSchema.optional(),
      [bestTakenType.CUSTOM]: z.array(time24HourSchema).optional(),
    }),
  )
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
    [frequencyType.ONCE_DAILY]: 1,
    [frequencyType.TWICE_DAILY]: 2,
    [frequencyType.THREE_TIMES_DAILY]: 3,
  };

  let selectedCount = 0;
  Object.values(data.medicationSchedule).forEach((value) => {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        selectedCount += value.length;
      } else {
        selectedCount += 1;
      }
    }
  });
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
    medicationType: medicationTypeField,
    prescribedBy: prescribedByField.optional().nullable(),
    dosePerIntake: doseField,
    frequency: frequencyField,
    medicationSchedule: medicationScheduleSchema,
    foodFrequency: foodFrequencyField,
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
    resolution: z
      .enum(["REPLACE", "KEEP_EXISTING", "EDIT", "KEEP_NEW", "REMOVE_NEW", "KEEP_BOTH"])
      .optional()
      .nullable(),
    replaceMedicationId: z.string().optional().nullable(),
    targetMedicationId: z.string().optional().nullable(),
    matchedMedicationId: z.string().optional().nullable(),
    refillAlert: z.boolean().optional(),
    unit: z.string().optional().nullable(),
    clientMedId: z.string().optional().nullable(),
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

    if (
      (data.resolution === "REPLACE" || data.resolution === "EDIT") &&
      !data.replaceMedicationId &&
      !data.targetMedicationId &&
      !data.matchedMedicationId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replaceMedicationId"],
        message: errorConstants.REPLACE_MEDICATION_ID_REQUIRED,
      });
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
    resolution: z
      .enum(["REPLACE", "KEEP_EXISTING", "EDIT", "KEEP_NEW", "REMOVE_NEW", "KEEP_BOTH"])
      .optional(),
    replaceMedicationId: z.string().optional(),
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

    if (
      (data.resolution === "REPLACE" || data.resolution === "EDIT") &&
      !data.replaceMedicationId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replaceMedicationId"],
        message: `replaceMedicationId is required when resolution is ${data.resolution}`,
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
          INJECTION: ["ml", "IU", "iu"],
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

const checkDuplicateMedicationSchema = z.object({
  medicationName: medicationNameField,
  medicationType: z
    .string()
    .trim()
    .refine((val) => medicationTypeValues.includes(val), {
      message: errorConstants.INVALID_MEDICATION_TYPE,
    })
    .optional()
    .nullable(),
});
const batchDeleteMedicationSchema = z.object({
  ids: z
    .array(
      z
        .string({
          required_error: errorConstants.INVALID_UUID,
          invalid_type_error: errorConstants.INVALID_UUID,
        })
        .uuid(errorConstants.INVALID_UUID),
      {
        required_error: "ids array is required",
        invalid_type_error: "ids must be an array of UUIDs",
      },
    )
    .min(1, errorConstants.AT_LEAST_ONE_MEDICATION_ID_REQUIRED),
});

const batchMedicationItemSchema = z
  .object({
    medicationName: medicationNameField,
    medicationType: medicationTypeField,
    prescribedBy: prescribedByField.optional().nullable(),
    dosePerIntake: doseField.default(1),
    frequency: frequencyField,
    medicationSchedule: medicationScheduleSchema.optional(),
    foodFrequency: foodFrequencyField,
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
    resolution: z
      .enum(["REPLACE", "KEEP_EXISTING", "EDIT", "KEEP_NEW", "REMOVE_NEW", "KEEP_BOTH"])
      .optional()
      .nullable(),
    replaceMedicationId: z.string().optional().nullable(),
    targetMedicationId: z.string().optional().nullable(),
    matchedMedicationId: z.string().optional().nullable(),
    selected: z.boolean().optional(),
    refillAlert: z.boolean().optional(),
    unit: z.string().optional().nullable(),
    clientMedId: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (
      data.selected === false ||
      data.resolution === "KEEP_EXISTING" ||
      data.resolution === "REMOVE_NEW"
    ) {
      return;
    }

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

    if (
      (data.resolution === "REPLACE" || data.resolution === "EDIT") &&
      !data.replaceMedicationId &&
      !data.targetMedicationId &&
      !data.matchedMedicationId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replaceMedicationId"],
        message: errorConstants.REPLACE_MEDICATION_ID_REQUIRED,
      });
    }

    validateMedicationSelections(data, ctx);
  });

const batchCreateMedicationSchema = z.union([
  z
    .array(batchMedicationItemSchema, {
      required_error: errorConstants.MEDICATIONS_ARRAY_REQUIRED,
      invalid_type_error: errorConstants.MEDICATIONS_ARRAY_REQUIRED,
    })
    .min(1, errorConstants.MEDICATIONS_ARRAY_REQUIRED),
  z
    .object({
      medications: z
        .array(batchMedicationItemSchema, {
          required_error: errorConstants.MEDICATIONS_ARRAY_REQUIRED,
          invalid_type_error: errorConstants.MEDICATIONS_ARRAY_REQUIRED,
        })
        .min(1, errorConstants.MEDICATIONS_ARRAY_REQUIRED),
    })
    .transform((val) => val.medications),
]);

module.exports = {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  refillMedicationSchema,
  medicationOnboardingSchema,
  checkDuplicateMedicationSchema,
  batchDeleteMedicationSchema,
  batchCreateMedicationSchema,
};
