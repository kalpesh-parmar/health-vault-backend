class MedicalFactValidatorService {
  constructor() {
    this.numericPattern =
      /\b([0-9]+(?:\.[0-9]+)?)\s*(%|mg\/dL|g\/dL|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|mg|ml|gm|cells\/cumm|cells\/mcL|M\/mcL|Mil\.\/cu mm|\/cmm)?\b/gi;
  }

  /**
   * Extract potential metric name and associated numeric value from text.
   * @param {string} text
   * @returns {Array<{ metric: string, value: number, unit: string | null }>}
   */
  extractClaims(text) {
    if (!text || typeof text !== "string") return [];
    const claims = [];

    // Catalog of known test keywords to scan for (ordered by specific to general)
    const metricKeywords = [
      { key: "glucose_fasting", synonyms: ["fasting blood sugar", "fasting glucose", "fbs"] },
      {
        key: "glucose_postprandial",
        synonyms: ["post prandial", "ppbs", "post-meal glucose", "post meal blood sugar"],
      },
      { key: "hba1c", synonyms: ["hba1c", "glycated hemoglobin", "a1c"] },
      { key: "hemoglobin", synonyms: ["hemoglobin", "hb"] },
      { key: "glucose_random", synonyms: ["random blood sugar", "rbs", "blood sugar", "glucose"] },
      { key: "creatinine_serum", synonyms: ["serum creatinine", "creatinine"] },
      { key: "cholesterol_total", synonyms: ["total cholesterol", "cholesterol"] },
      { key: "triglycerides", synonyms: ["triglycerides", "tg"] },
      { key: "cholesterol_hdl", synonyms: ["hdl", "hdl cholesterol"] },
      { key: "cholesterol_ldl", synonyms: ["ldl", "ldl cholesterol"] },
      { key: "platelet_count", synonyms: ["platelet count", "platelets"] },
      { key: "wbc_count", synonyms: ["white blood cell", "wbc count", "wbc"] },
      { key: "rbc_count", synonyms: ["red blood cell", "rbc count", "rbc"] },
      { key: "tsh", synonyms: ["tsh", "thyroid stimulating hormone"] },
    ];

    const sentences = text
      .split(/\r?\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      // Find all metric mentions with positions
      const foundMetrics = [];
      for (const m of metricKeywords) {
        for (const syn of m.synonyms) {
          const regex = new RegExp(`\\b${syn}\\b`, "gi");
          let match;
          while ((match = regex.exec(sentence)) !== null) {
            foundMetrics.push({
              key: m.key,
              synonym: syn,
              start: match.index,
              end: match.index + match[0].length,
            });
          }
        }
      }

      // Filter out overlapping sub-matches (e.g. keep "fasting blood sugar" over "blood sugar")
      foundMetrics.sort((a, b) => b.end - b.start - (a.end - a.start));
      const filteredMetrics = [];
      for (const met of foundMetrics) {
        const overlaps = filteredMetrics.some((f) => met.start < f.end && met.end > f.start);
        if (!overlaps) {
          filteredMetrics.push(met);
        }
      }
      filteredMetrics.sort((a, b) => a.start - b.start);

      if (filteredMetrics.length === 0) continue;

      // Find all numbers in this sentence
      const numberRegex =
        /\b([0-9]+(?:\.[0-9]+)?)\s*(%|mg\/dL|g\/dL|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|mg|ml|gm|cells\/cumm|cells\/mcL|M\/mcL|Mil\.\/cu mm|\/cmm)?\b/gi;
      let numMatch;
      while ((numMatch = numberRegex.exec(sentence)) !== null) {
        const num = parseFloat(numMatch[1]);
        if (num >= 1990 && num <= 2040 && !numMatch[2]) continue;

        const numStart = numMatch.index;

        // Associate with closest metric (preferring preceding metric within 80 chars, or succeeding within 40 chars)
        let closestMetric = null;
        let minDistance = Infinity;

        for (const met of filteredMetrics) {
          let dist;
          if (met.end <= numStart) {
            dist = numStart - met.end; // preceding metric
          } else {
            dist = (met.start - (numStart + numMatch[0].length)) * 1.5; // succeeding metric penalty
          }

          if (dist < minDistance && dist < 100) {
            minDistance = dist;
            closestMetric = met;
          }
        }

        if (closestMetric) {
          claims.push({
            metric: closestMetric.key,
            matchedSynonym: closestMetric.synonym,
            value: num,
            unit: numMatch[2] || null,
            rawMatch: numMatch[0],
            sentence,
          });
        }
      }
    }

    return claims;
  }

  /**
   * Validate generated LLM text against verified structured medical records.
   * @param {string} generatedText
   * @param {Array<object>} structuredRecords Verified records from PostgreSQL
   * @returns {{ isValid: boolean, claims: Array<object>, hallucinations: Array<object>, sanitizedText: string }}
   */
  verifyMedicalFacts(generatedText, structuredRecords = []) {
    if (!generatedText || typeof generatedText !== "string") {
      return { isValid: true, claims: [], hallucinations: [], sanitizedText: generatedText };
    }

    if (!Array.isArray(structuredRecords) || structuredRecords.length === 0) {
      return { isValid: true, claims: [], hallucinations: [], sanitizedText: generatedText };
    }

    const claims = this.extractClaims(generatedText);
    if (claims.length === 0) {
      return { isValid: true, claims: [], hallucinations: [], sanitizedText: generatedText };
    }

    const hallucinations = [];
    let sanitizedText = generatedText;

    for (const claim of claims) {
      // Find matching structured records by canonical name or test name
      const candidates = structuredRecords.filter((rec) => {
        const recCanonical = rec.canonicalName || rec.testName?.toLowerCase().replace(/\s+/g, "_");
        if (recCanonical === claim.metric) return true;
        if (
          claim.metric === "glucose_random" &&
          (recCanonical === "glucose_fasting" || recCanonical === "glucose_postprandial")
        ) {
          return true;
        }
        return false;
      });

      if (candidates.length === 0) continue;

      // If any candidate matches within tolerance, accept the claim as verified
      const isClaimVerified = candidates.some((rec) => {
        if (rec.numericValue == null) return false;
        return Math.abs(parseFloat(rec.numericValue) - claim.value) <= 0.2;
      });

      if (!isClaimVerified) {
        const matchingRecord = candidates[0];
        const expectedVal = parseFloat(matchingRecord.numericValue);
        const actualClaimVal = claim.value;
        const diff = Math.abs(expectedVal - actualClaimVal);

        // Tolerance: difference > 0.2 is flagged as discrepancy
        if (diff > 0.2) {
          hallucinations.push({
            metric: claim.metric,
            statedValue: actualClaimVal,
            statedUnit: claim.unit,
            actualValue: expectedVal,
            actualUnit: matchingRecord.unit,
            testName: matchingRecord.testName,
            referenceRange: matchingRecord.referenceRange,
            sentence: claim.sentence,
          });

          // Correct the hallucination in the sentence
          const expectedStr = `${expectedVal}${matchingRecord.unit ? " " + matchingRecord.unit : ""}`;
          const correction = `${expectedStr} (Verified: ${expectedVal} ${matchingRecord.unit || ""})`;
          if (claim.sentence && sanitizedText.includes(claim.sentence)) {
            const updatedSentence = claim.sentence.replace(claim.rawMatch, correction);
            sanitizedText = sanitizedText.replace(claim.sentence, updatedSentence);
          } else {
            sanitizedText = sanitizedText.replace(claim.rawMatch, correction);
          }
        }
      }
    }

    const isValid = hallucinations.length === 0;

    if (!isValid) {
      const correctionNote = hallucinations
        .map(
          (h) =>
            `\n\n⚠️ **Verified Clinical Discrepancy Notice**: Official laboratory records show **${h.testName}** is **${h.actualValue} ${h.actualUnit || ""}** (Reference Range: ${h.referenceRange || "Standard"}), differing from generated output.`,
        )
        .join("");

      if (!sanitizedText.includes("Verified Clinical Discrepancy Notice")) {
        sanitizedText += correctionNote;
      }
    }

    return {
      isValid,
      claims,
      hallucinations,
      sanitizedText,
    };
  }
}

const medicalFactValidatorService = new MedicalFactValidatorService();

module.exports = {
  MedicalFactValidatorService,
  medicalFactValidatorService,
};
