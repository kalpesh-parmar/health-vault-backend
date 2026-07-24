const { z } = require("zod");

const TestResultSchema = z.object({
  testName: z.string().nullable().default(null),
  value: z.string().nullable().or(z.number().nullable()).default(null),
  unit: z.string().nullable().default(null),
  referenceRange: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
});

const MedicationSchema = z.object({
  name: z.string().nullable().default(null),
  dosage: z.string().nullable().default(null),
  frequency: z.string().nullable().default(null),
  duration: z.string().nullable().default(null),
  instructions: z.string().nullable().default(null),
});

const MedicalExtractionSchema = z.object({
  patientName: z.string().nullable().default(null),
  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  age: z.number().nullable().or(z.string().nullable()).default(null),
  gender: z.string().nullable().default(null),
  reportDate: z.string().nullable().default(null),
  visitDate: z.string().nullable().default(null),
  dateOfBirth: z.string().nullable().default(null),
  doctorName: z.string().nullable().default(null),
  hospitalName: z.string().nullable().default(null),
  diagnosis: z.string().nullable().or(z.array(z.string())).default(null),
  medications: z.array(MedicationSchema).default([]),
  testResults: z.array(TestResultSchema).default([]),
  remarks: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phoneNumber: z.string().nullable().default(null),
  bloodGroup: z.string().nullable().default(null),
  allergies: z.array(z.string()).default([]),
  medicalConditions: z.array(z.string()).default([]),
  address: z.string().nullable().default(null),
});

module.exports = {
  TestResultSchema,
  MedicationSchema,
  MedicalExtractionSchema,
};
