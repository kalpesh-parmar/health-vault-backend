const { updatePatientSchema } = require("../../src/validations/patientValidation");
const { normalizeLanguage } = require("../../src/helpers/summary.helper");

describe("Patient Preferred Language Validation", () => {
  it("allows valid languages in updatePatientSchema", () => {
    const validLangs = ["english", "gujarati", "hindi", "marathi", "tamil"];
    for (const lang of validLangs) {
      const res = updatePatientSchema.safeParse({ preferredLanguage: lang });
      expect(res.success).toBe(true);
      expect(res.data.preferredLanguage).toBe(lang);
    }
  });

  it("rejects invalid languages in updatePatientSchema", () => {
    const res = updatePatientSchema.safeParse({ preferredLanguage: "spanish" });
    expect(res.success).toBe(false);
  });

  it("normalizes language codes to canonical language names", () => {
    expect(normalizeLanguage("en")).toBe("english");
    expect(normalizeLanguage("gu")).toBe("gujarati");
    expect(normalizeLanguage("hi")).toBe("hindi");
    expect(normalizeLanguage("mr")).toBe("marathi");
    expect(normalizeLanguage("ta")).toBe("tamil");
    expect(normalizeLanguage("HINDI")).toBe("hindi");
    expect(normalizeLanguage("french")).toBe("english");
  });
});
