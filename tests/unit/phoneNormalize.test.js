const { normalizePhoneNumber } = require("../../src/utils/commonUtils");

describe("normalizePhoneNumber Utility Tests", () => {
  test("should split combined mobile number with + country code (+919876543210)", () => {
    const result = normalizePhoneNumber({ mobile: "+919876543210" });
    expect(result.mobile).toBe("9876543210");
    expect(result.countryCode).toBe("+91");
  });

  test("should split 12-digit number without + prefix (919876543210)", () => {
    const result = normalizePhoneNumber({ mobile: "919876543210" });
    expect(result.mobile).toBe("9876543210");
    expect(result.countryCode).toBe("+91");
  });

  test("should keep 10-digit mobile number intact and format separate countryCode", () => {
    const result = normalizePhoneNumber({ mobile: "9876543210", countryCode: "91" });
    expect(result.mobile).toBe("9876543210");
    expect(result.countryCode).toBe("+91");
  });

  test("should handle existing + format in countryCode and 10-digit mobile", () => {
    const result = normalizePhoneNumber({ mobile: "9876543210", countryCode: "+91" });
    expect(result.mobile).toBe("9876543210");
    expect(result.countryCode).toBe("+91");
  });

  test("should default countryCode to +91 for 10-digit mobile number when countryCode is omitted", () => {
    const result = normalizePhoneNumber({ mobile: "9876543210" });
    expect(result.mobile).toBe("9876543210");
    expect(result.countryCode).toBe("+91");
  });

  test("should handle null inputs gracefully", () => {
    const result = normalizePhoneNumber({ mobile: null, countryCode: null });
    expect(result.mobile).toBeNull();
    expect(result.countryCode).toBeNull();
  });

  test("should return countryCode as null when mobile is null or empty string", () => {
    const res1 = normalizePhoneNumber({ mobile: null, countryCode: "+91" });
    expect(res1.mobile).toBeNull();
    expect(res1.countryCode).toBeNull();

    const res2 = normalizePhoneNumber({ mobile: "", countryCode: "+91" });
    expect(res2.mobile).toBeNull();
    expect(res2.countryCode).toBeNull();
  });
});
