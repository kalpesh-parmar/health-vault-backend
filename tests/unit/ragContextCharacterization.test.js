const {
  getReportAgeString,
  paginateArray,
} = require("../../src/services/ai/chat/ragContext.service");

describe("ragContextCharacterization Tests", () => {
  describe("getReportAgeString boundary and language characterization", () => {
    const languages = ["english", "hindi", "gujarati", "marathi", "tamil"];
    const boundaries = [0, 1, 29, 30, 59, 60, 364, 365, 730];

    test("invalid or missing dates return empty string", () => {
      expect(getReportAgeString(null, "english")).toBe("");
      expect(getReportAgeString(undefined, "english")).toBe("");
      expect(getReportAgeString("", "english")).toBe("");
      expect(getReportAgeString("invalid-date", "english")).toBe("");
    });

    test("unknown language normalizes to English and returns English age strings", () => {
      const now = new Date();
      expect(getReportAgeString(now, "klingon")).toBe("Today");

      const past10Days = new Date(now.getTime() - 10 * 86400000);
      expect(getReportAgeString(past10Days, "klingon")).toBe("10 days old");

      const past40Days = new Date(now.getTime() - 40 * 86400000);
      expect(getReportAgeString(past40Days, "klingon")).toBe("1 month old");

      const past400Days = new Date(now.getTime() - 400 * 86400000);
      expect(getReportAgeString(past400Days, "klingon")).toBe("1 year old");
    });

    languages.forEach((lang) => {
      describe(`Language: ${lang}`, () => {
        boundaries.forEach((diffDays) => {
          test(`boundary ${diffDays} days`, () => {
            const today = new Date();
            const targetDate = new Date(
              today.getFullYear(),
              today.getMonth(),
              today.getDate() - diffDays,
            );

            const result = getReportAgeString(targetDate, lang);

            if (diffDays === 0) {
              const expectedToday = {
                english: "Today",
                gujarati: "આજનો",
                hindi: "आज का",
                marathi: "आजचा",
                tamil: "இன்றைய",
              }[lang];
              expect(result).toBe(expectedToday);
            } else if (diffDays < 30) {
              if (lang === "english") {
                expect(result).toBe(diffDays === 1 ? "1 day old" : `${diffDays} days old`);
              } else if (lang === "gujarati") {
                expect(result).toBe(`${diffDays} દિવસ જૂનો`);
              } else if (lang === "hindi") {
                expect(result).toBe(`${diffDays} दिन पुराना`);
              } else if (lang === "marathi") {
                expect(result).toBe(`${diffDays} दिवस जुना`);
              } else if (lang === "tamil") {
                expect(result).toBe(`${diffDays} நாள் பழமையானது`);
              }
            } else if (diffDays < 365) {
              const m = Math.floor(diffDays / 30);
              if (lang === "english") {
                expect(result).toBe(m === 1 ? "1 month old" : `${m} months old`);
              } else if (lang === "gujarati") {
                expect(result).toBe(`${m} મહિના જૂનો`);
              } else if (lang === "hindi") {
                expect(result).toBe(`${m} महीने पुराना`);
              } else if (lang === "marathi") {
                expect(result).toBe(`${m} महिने जुना`);
              } else if (lang === "tamil") {
                expect(result).toBe(`${m} மாதங்கள் பழமையானது`);
              }
            } else {
              const y = Math.floor(diffDays / 365);
              if (lang === "english") {
                expect(result).toBe(y === 1 ? "1 year old" : `${y} years old`);
              } else if (lang === "gujarati") {
                expect(result).toBe(`${y} વર્ષ જૂનો`);
              } else if (lang === "hindi") {
                expect(result).toBe(`${y} साल पुराना`);
              } else if (lang === "marathi") {
                expect(result).toBe(`${y} वर्षे जुना`);
              } else if (lang === "tamil") {
                expect(result).toBe(`${y} ஆண்டுகள் பழமையானது`);
              }
            }
          });
        });
      });
    });
  });

  describe("paginateArray characterization", () => {
    test("handles empty array or non-array inputs safely", () => {
      const empty = paginateArray([], { page: 1, limit: 10 });
      expect(empty.data).toEqual([]);
      expect(empty.page).toEqual({
        pageNumber: 1,
        pageLimit: 10,
        totalPages: 1,
        totalRecords: 0,
        hasNextPage: false,
        hasPrevPage: false,
      });

      const nonArray = paginateArray(null, { page: 1, limit: 10 });
      expect(nonArray.data).toEqual([]);
      expect(nonArray.page.totalRecords).toBe(0);
    });

    test("defaults page and limit properly", () => {
      const res = paginateArray([1, 2, 3]);
      expect(res.data).toEqual([1, 2, 3]);
      expect(res.page.pageNumber).toBe(1);
      expect(res.page.pageLimit).toBe(20);
      expect(res.page.totalPages).toBe(1);
      expect(res.page.totalRecords).toBe(3);
    });

    test("clamps page numbers within range", () => {
      const res = paginateArray([1, 2, 3], { page: 99, limit: 10 });
      expect(res.page.pageNumber).toBe(1); // Clamped to totalPages = 1
      expect(res.data).toEqual([1, 2, 3]);
    });
  });
});
