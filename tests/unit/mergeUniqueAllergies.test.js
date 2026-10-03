const { mergeUniqueAllergies } = require("../../src/utils/commonUtils");

describe("mergeUniqueAllergies Utility Tests", () => {
  test("should merge DB allergies and new chatbot allergies with deduplication", () => {
    const dbAllergies = ["Peanuts", "Dust"];
    const chatbotAllergies = ["Pollen", "Peanuts"];
    const result = mergeUniqueAllergies(dbAllergies, chatbotAllergies);

    expect(result).toEqual(["Peanuts", "Dust", "Pollen"]);
  });

  test("should handle case-insensitive duplicates (peanuts vs Peanuts vs PEANUTS)", () => {
    const dbAllergies = ["Peanuts", "Penicillin"];
    const chatbotAllergies = ["peanuts", "dust", "PENICILLIN"];
    const result = mergeUniqueAllergies(dbAllergies, chatbotAllergies);

    expect(result).toEqual(["Peanuts", "Penicillin", "dust"]);
  });

  test("should handle empty array or non-array inputs safely", () => {
    expect(mergeUniqueAllergies([], ["Pollen"])).toEqual(["Pollen"]);
    expect(mergeUniqueAllergies(["Dust"], [])).toEqual(["Dust"]);
    expect(mergeUniqueAllergies(null, undefined)).toEqual([]);
  });

  test("should clean whitespace from items", () => {
    const dbAllergies = ["  Peanuts  "];
    const chatbotAllergies = ["Peanuts", "  Dust Allergy "];
    const result = mergeUniqueAllergies(dbAllergies, chatbotAllergies);

    expect(result).toEqual(["Peanuts", "Dust Allergy"]);
  });
});
