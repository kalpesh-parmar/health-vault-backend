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

  test("should handle null inputs gracefully", () => {
    const result = normalizePhoneNumber({ mobile: null, countryCode: null });
    expect(result.mobile).toBeNull();
    expect(result.countryCode).toBeNull();
  });
});
