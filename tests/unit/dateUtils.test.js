const { toDbDate, toDbTimestamp } = require("../../src/utils/dateUtils");

describe("dbDate Utility Unit Tests", () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("null and undefined return null without logging", () => {
    expect(toDbDate(null)).toBeNull();
    expect(toDbDate(undefined)).toBeNull();
    expect(toDbTimestamp(null)).toBeNull();
    expect(toDbTimestamp(undefined)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("empty or whitespace-only strings return null without logging", () => {
    expect(toDbDate("")).toBeNull();
    expect(toDbDate("   ")).toBeNull();
    expect(toDbDate("\t\n")).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("Valid Date instances are returned directly", () => {
    const d = new Date(Date.UTC(2025, 0, 15));
    const res = toDbDate(d);
    expect(res).toBe(d);
    expect(res.getTime()).toBe(d.getTime());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("Invalid Date instances return null and log a warning", () => {
    const invalid = new Date("invalid date");
    expect(toDbDate(invalid, { documentId: "doc_1" })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("INVALID_DATE_COERCION");
  });

  test("Numeric timestamps are converted to valid Dates", () => {
    const epoch = 1736899200000; // 2025-01-15T00:00:00.000Z
    const res = toDbDate(epoch);
    expect(res).toBeInstanceOf(Date);
    expect(res.getTime()).toBe(epoch);
    expect(warnSpy).not.toHaveBeenCalled();

    expect(toDbDate(NaN)).toBeNull();
    expect(toDbDate(Infinity)).toBeNull();
  });

  test("ISO date-only strings 'YYYY-MM-DD' are anchored to UTC midnight", () => {
    const res = toDbDate("2025-01-15");
    expect(res).toBeInstanceOf(Date);
    expect(res.toISOString()).toBe("2025-01-15T00:00:00.000Z");
    expect(res.getUTCFullYear()).toBe(2025);
    expect(res.getUTCMonth()).toBe(0); // Jan
    expect(res.getUTCDate()).toBe(15);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("Calendar rollover dates like 2025-02-30 return null and log warning", () => {
    const res = toDbDate("2025-02-30", { documentId: "doc_rollover" });
    expect(res).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("doc_rollover");
    expect(warnSpy.mock.calls[0][0]).toContain("2025-02-30");
  });

  test("Other impossible dates return null", () => {
    expect(toDbDate("2025-04-31")).toBeNull();
    expect(toDbDate("2025-13-01")).toBeNull();
    expect(toDbDate("2025-00-10")).toBeNull();
    expect(toDbDate("0000-00-00")).toBeNull();
  });

  test("Garbage strings return null and log warning", () => {
    expect(toDbDate("N/A")).toBeNull();
    expect(toDbDate("unknown")).toBeNull();
    expect(toDbDate("not found")).toBeNull();
    expect(toDbDate("gibberish")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("Non-coercible types return null and log warning", () => {
    expect(toDbDate({})).toBeNull();
    expect(toDbDate([1, 2, 3])).toBeNull();
    expect(toDbDate(true)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("toDbTimestamp alias works identically", () => {
    expect(toDbTimestamp("2025-01-15").toISOString()).toBe("2025-01-15T00:00:00.000Z");
    expect(toDbTimestamp("invalid")).toBeNull();
  });
});
