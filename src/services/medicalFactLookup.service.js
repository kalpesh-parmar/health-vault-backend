const { patientLabResultRepository } = require("../repositories/patientLabResultRepository");

const CANONICAL_SYNONYMS = {
  fbs: "glucose_fasting",
  fasting_sugar: "glucose_fasting",
  fasting_blood_sugar: "glucose_fasting",
  fasting_glucose: "glucose_fasting",
  ppbs: "glucose_postprandial",
  post_meal_sugar: "glucose_postprandial",
  post_prandial_sugar: "glucose_postprandial",
  rbs: "glucose_random",
  random_sugar: "glucose_random",
  sugar: "glucose_random",
  glucose: "glucose_random",
  hba1c: "hba1c",
  hb: "hemoglobin",
  hemoglobin: "hemoglobin",
  creatinine: "creatinine_serum",
  serum_creatinine: "creatinine_serum",
  tsh: "tsh",
  thyroid: "tsh",
  cholesterol: "cholesterol_total",
  lipid: "cholesterol_total",
  ldl: "cholesterol_ldl",
  hdl: "cholesterol_hdl",
  triglycerides: "triglycerides",
  wbc: "wbc_count",
  platelets: "platelet_count",
};

const CANONICAL_KEYS = new Set(Object.values(CANONICAL_SYNONYMS));
const SORTED_SYNONYM_ENTRIES = Object.entries(CANONICAL_SYNONYMS).sort(
  (a, b) => b[0].length - a[0].length,
);

class MedicalFactLookupService {
  resolveCanonicalKey(queryOrKey) {
    if (!queryOrKey) return null;
    const clean = queryOrKey
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .trim();
    if (CANONICAL_KEYS.has(clean)) return clean;
    if (CANONICAL_SYNONYMS[clean]) return CANONICAL_SYNONYMS[clean];

    for (const [syn, key] of SORTED_SYNONYM_ENTRIES) {
      if (clean.includes(syn)) return key;
    }
    return queryOrKey;
  }

  async lookupFact(userId, metricQuery, { startDate, endDate, limit = 10, documentIds } = {}) {
    const canonicalKey = this.resolveCanonicalKey(metricQuery);
    if (!canonicalKey) return { results: [], canonicalKey: null };

    const results = await patientLabResultRepository.findByCanonicalKey(userId, canonicalKey, {
      startDate,
      endDate,
      limit,
      documentIds,
    });

    return {
      canonicalKey,
      results,
      count: results.length,
      latest: results.length > 0 ? results[results.length - 1] : null,
    };
  }

  formatAsMarkdownTable(results) {
    if (!results || results.length === 0) {
      return "No structured laboratory records found for this test.";
    }

    const headers = "| Test Date | Test Name | Result | Unit | Reference Range | Status | Source |";
    const separator = "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |";

    const rows = results.map((r) => {
      const dateStr = r.testDate ? new Date(r.testDate).toISOString().split("T")[0] : "N/A";
      const value = r.valueNumeric != null ? r.valueNumeric : r.valueText || "N/A";
      const unit = r.unit || "";
      const range = r.referenceRange || "Normal";
      const flag = r.isAbnormal ? `**${r.flag || "ABNORMAL"}**` : "NORMAL";
      const source = r.pageNo ? `Page ${r.pageNo}` : "Report";
      return `| ${dateStr} | ${r.testName} | ${value} | ${unit} | ${range} | ${flag} | ${source} |`;
    });

    return [headers, separator, ...rows].join("\n");
  }
}

const medicalFactLookupService = new MedicalFactLookupService();

module.exports = {
  medicalFactLookupService,
  MedicalFactLookupService,
  CANONICAL_SYNONYMS,
};
