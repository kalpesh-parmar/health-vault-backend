const { inArray } = require("drizzle-orm");
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { patientLabResultRepository } = require("../repositories/patientLabResultRepository");

const METRIC_CONFIG = {
  glucose_fasting: {
    title: "Fasting Blood Sugar Trend",
    canonicalUnit: "mg/dL",
    refLow: 70.0,
    refHigh: 99.0,
    refLabel: "Normal: 70 - 99 mg/dL",
  },
  glucose_postprandial: {
    title: "Post-Meal Blood Sugar Trend",
    canonicalUnit: "mg/dL",
    refLow: 70.0,
    refHigh: 140.0,
    refLabel: "Normal: < 140 mg/dL",
  },
  glucose_random: {
    title: "Blood Glucose Trend",
    canonicalUnit: "mg/dL",
    refLow: 70.0,
    refHigh: 140.0,
    refLabel: "Normal: 70 - 140 mg/dL",
  },
  hba1c: {
    title: "HbA1c (Glycated Hemoglobin) Trend",
    canonicalUnit: "%",
    refLow: 4.0,
    refHigh: 5.6,
    refLabel: "Normal: < 5.7%",
  },
  hemoglobin: {
    title: "Hemoglobin Trend",
    canonicalUnit: "g/dL",
    refLow: 12.0,
    refHigh: 17.5,
    refLabel: "Normal: 12.0 - 17.5 g/dL",
  },
  creatinine_serum: {
    title: "Serum Creatinine Trend",
    canonicalUnit: "mg/dL",
    refLow: 0.6,
    refHigh: 1.2,
    refLabel: "Normal: 0.6 - 1.2 mg/dL",
  },
  cholesterol_total: {
    title: "Total Cholesterol Trend",
    canonicalUnit: "mg/dL",
    refLow: 125.0,
    refHigh: 200.0,
    refLabel: "Normal: < 200 mg/dL",
  },
  tsh: {
    title: "Thyroid Stimulating Hormone (TSH) Trend",
    canonicalUnit: "mIU/L",
    refLow: 0.4,
    refHigh: 4.0,
    refLabel: "Normal: 0.4 - 4.0 mIU/L",
  },
};

class MedicalTrendChartService {
  /**
   * Normalizes values across lab units to canonical clinical units.
   */
  normalizeValue(value, fromUnit, canonicalKey) {
    if (value == null) return null;
    const num = Number(value);
    if (isNaN(num)) return null;

    const unit = String(fromUnit || "")
      .toLowerCase()
      .trim();

    if (canonicalKey.startsWith("glucose") || canonicalKey === "cholesterol_total") {
      if (unit.includes("mmol")) {
        const factor = canonicalKey === "cholesterol_total" ? 38.67 : 18.0182;
        return Number((num * factor).toFixed(1));
      }
    }

    if (canonicalKey === "hemoglobin") {
      if (unit === "g/l") {
        return Number((num / 10).toFixed(1));
      }
    }

    if (canonicalKey === "creatinine_serum") {
      if (unit.includes("umol") || unit.includes("µmol")) {
        return Number((num / 88.4).toFixed(2));
      }
    }

    return Number(num.toFixed(2));
  }

  /**
   * Generates structured trend chart JSON from PostgreSQL verified lab results.
   */
  async generateTrendChart({
    userId,
    canonicalKey,
    granularity = "date",
    startDate = null,
    endDate = null,
    documentIds = null,
  }) {
    if (!userId || !canonicalKey) {
      throw new Error("userId and canonicalKey are required to generate medical chart.");
    }

    const config = METRIC_CONFIG[canonicalKey] || {
      title: `${canonicalKey.replace(/_/g, " ").toUpperCase()} Trend`,
      canonicalUnit: "",
      refLow: null,
      refHigh: null,
      refLabel: "Reference range not specified",
    };

    let rawObservations = [];

    if (granularity === "month" || granularity === "year") {
      rawObservations = await patientLabResultRepository.aggregateByPeriod(
        userId,
        canonicalKey,
        granularity,
        { startDate, endDate, documentIds },
      );
    } else {
      rawObservations = await patientLabResultRepository.findByCanonicalKey(userId, canonicalKey, {
        startDate,
        endDate,
        limit: 100,
        documentIds,
      });
    }

    if (!rawObservations || rawObservations.length === 0) {
      return {
        hasData: false,
        message: `No laboratory results found for ${config.title}.`,
        chart: null,
      };
    }

    // Fetch document names for citations
    const docMap = new Map();
    const docIds = Array.from(new Set(rawObservations.map((o) => o.documentId).filter(Boolean)));
    if (docIds.length > 0) {
      try {
        const docRows = await db
          .select({ id: document.id, fileName: document.fileName })
          .from(document)
          .where(inArray(document.id, docIds));
        for (const row of docRows) {
          docMap.set(row.id, decodeURIComponent(row.fileName || "Medical Report"));
        }
      } catch {
        // Fallback gracefully
      }
    }

    const points = rawObservations
      .map((obs) => {
        const rawDate = obs.testDate || obs.period;
        let dateIso = "Unknown";
        let displayDate = "Unknown";
        if (rawDate) {
          const dObj = new Date(rawDate);
          if (!isNaN(dObj.getTime())) {
            const y = dObj.getFullYear();
            const m = String(dObj.getMonth() + 1).padStart(2, "0");
            const day = String(dObj.getDate()).padStart(2, "0");
            dateIso = `${y}-${m}-${day}`;
            displayDate =
              granularity === "year" ? String(y) : granularity === "month" ? `${y}-${m}` : dateIso;
          }
        }

        const rawVal = obs.valueNumeric != null ? obs.valueNumeric : obs.avgValue;
        const normalizedVal = this.normalizeValue(rawVal, obs.unit, canonicalKey);

        let isAbnormal = obs.isAbnormal || false;
        if (config.refLow != null && config.refHigh != null && normalizedVal != null) {
          if (normalizedVal < config.refLow || normalizedVal > config.refHigh) {
            isAbnormal = true;
          }
        }

        const docName = obs.documentId ? docMap.get(obs.documentId) || "Medical Report" : undefined;

        return {
          date: dateIso,
          displayDate,
          label: displayDate,
          value: normalizedVal,
          unit: config.canonicalUnit || obs.unit,
          isAbnormal,
          status: isAbnormal ? "ABNORMAL" : "NORMAL",
          documentId: obs.documentId || null,
          documentName: docName,
          pageNumber: obs.pageNo || 1,
          pageNo: obs.pageNo || 1,
        };
      })
      .filter((p) => p.value != null && !isNaN(p.value));

    if (points.length === 0) {
      return {
        hasData: false,
        message: `No numeric laboratory observations found for ${config.title}.`,
        chart: null,
      };
    }

    const values = points.map((p) => p.value).filter((v) => v != null);
    const minVal = values.length > 0 ? Math.min(...values) : null;
    const maxVal = values.length > 0 ? Math.max(...values) : null;
    const sumVal = values.reduce((acc, v) => acc + v, 0);
    const meanVal = values.length > 0 ? Number((sumVal / values.length).toFixed(1)) : null;

    const firstVal = points[0]?.value;
    const latestVal = points[points.length - 1]?.value;
    let changePercentage = null;
    let trendDirection = "stable";

    if (firstVal != null && latestVal != null && firstVal > 0) {
      changePercentage = Number((((latestVal - firstVal) / firstVal) * 100).toFixed(1));
      if (changePercentage > 2.0) trendDirection = "increasing";
      else if (changePercentage < -2.0) trendDirection = "decreasing";
    }

    const chartPayload = {
      type: "chart",
      chartId: `chart_${canonicalKey}_${Date.now()}`,
      metric: canonicalKey,
      metricLabel: config.title,
      title: config.title,
      unit: config.canonicalUnit,
      canonicalUnit: config.canonicalUnit,
      granularity,
      referenceRange: {
        low: config.refLow,
        high: config.refHigh,
        min: config.refLow,
        max: config.refHigh,
        label: config.refLabel,
        unit: config.canonicalUnit,
      },
      points,
      dataPoints: points,
      summary: {
        firstValue: firstVal,
        latestValue: latestVal,
        changePercentage,
        trendDirection,
        totalPoints: points.length,
        latest: latestVal,
        latestDate: points[points.length - 1]?.date,
        min: minVal,
        max: maxVal,
        mean: meanVal,
        count: points.length,
      },
    };

    return {
      hasData: true,
      chart: chartPayload,
    };
  }
}

const medicalTrendChartService = new MedicalTrendChartService();

module.exports = {
  medicalTrendChartService,
  MedicalTrendChartService,
  METRIC_CONFIG,
};
