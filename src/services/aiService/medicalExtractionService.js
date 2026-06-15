// aiServiceClient removed

function pickEntities(entities, type) {
  if (!Array.isArray(entities)) return [];
  return entities.filter((entity) => (entity?.type || "").toLowerCase() === type);
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pickReportDate(normalized) {
  for (const prescription of normalized.prescriptions || []) {
    if (prescription?.issueDate) return prescription.issueDate;
  }
  const dateEntities = pickEntities(normalized.medicalEntities, "date");
  if (dateEntities.length) return dateEntities[0].value || dateEntities[0].name;
  return null;
}

function pickFirstField(rows, field) {
  for (const row of rows || []) {
    if (row?.[field]) return row[field];
  }
  return null;
}

function buildMedications(normalized) {
  const medications = [];

  for (const med of normalized.medications || []) {
    if (!med) continue;
    medications.push({
      dosage: med?.dosage || med?.dose || null,
      duration: med?.duration || null,
      frequency: med?.frequency || null,
      instructions: med?.instructions || med?.notes || null,
      name: med?.name || med?.medicineName || med?.medicationName || null,
      timing: med?.timing || med?.when || null,
    });
  }

  for (const prescription of normalized.prescriptions || []) {
    for (const med of prescription?.medications || []) {
      medications.push({
        dosage: med?.dosage || null,
        duration: med?.duration || null,
        frequency: med?.frequency || null,
        instructions: med?.instructions || null,
        name: med?.name || med?.medicineName || null,
        timing: med?.timing || null,
      });
    }
  }

  return medications.filter((m) => m.name);
}

function buildLabResults(normalized) {
  const labRows = [];

  for (const result of normalized.labResults || []) {
    if (!result) continue;
    labRows.push({
      category: result?.category || result?.panel || null,
      isAbnormal: !!result?.isAbnormal,
      name: result?.name || result?.testName || null,
      normalRange: result?.normalRange || result?.referenceRange || null,
      unit: result?.unit || null,
      value: result?.value || null,
    });
  }

  for (const lab of normalized.labReports || []) {
    for (const result of lab?.results || []) {
      labRows.push({
        category: lab?.title || null,
        isAbnormal: !!result?.isAbnormal,
        name: result?.name || null,
        normalRange: result?.normalRange || null,
        unit: result?.unit || null,
        value: result?.value || null,
      });
    }
  }

  for (const entity of pickEntities(normalized.medicalEntities, "test_value")) {
    labRows.push({
      category: "entity",
      isAbnormal: !!entity.isAbnormal,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  for (const entity of pickEntities(normalized.medicalEntities, "abnormal_value")) {
    labRows.push({
      category: "abnormal",
      isAbnormal: true,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  return labRows.filter((row) => row.name || row.value);
}

function buildDiagnosis(normalized, summary) {
  const diseaseEntities = pickEntities(normalized.medicalEntities, "disease")
    .map((entity) => entity.value || entity.name)
    .filter(Boolean);
  return uniqueStrings([
    ...asArray(normalized.diagnosis),
    ...diseaseEntities,
    ...asArray(summary?.diagnosis),
  ]);
}

function buildVitals(normalized) {
  return asArray(normalized.vitals)
    .filter(Boolean)
    .map((vital) => (typeof vital === "string" ? { value: vital } : vital));
}

function joinForText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || null;
}

class MedicalExtractionService {
  async extract({ rawOcr, patientContext = null }) {
    const ocrPayload = rawOcr?.structuredDocument || rawOcr?.ocr || rawOcr || {};

    const normalized = {
      confidence: ocrPayload?.confidence ?? rawOcr?.metadata?.confidence ?? 0,
      fullText: ocrPayload?.fullText || ocrPayload?.text || rawOcr?.ocr_text || "",
      labReports: ocrPayload?.labReports || [],
      language: ocrPayload?.language || null,
      medicalEntities: ocrPayload?.medicalEntities || [],
      pageCount: ocrPayload?.pageCount || rawOcr?.metadata?.pageCount || 0,
      paragraphs: ocrPayload?.paragraphs || [],
      patientInfo: ocrPayload?.medicalExtraction?.patientInfo || ocrPayload?.patientInfo || {},
      hospitalInfo: ocrPayload?.medicalExtraction?.hospitalInfo || ocrPayload?.hospitalInfo || {},
      doctorInfo: ocrPayload?.medicalExtraction?.doctorInfo || ocrPayload?.doctorInfo || {},
      diagnosis: ocrPayload?.medicalExtraction?.diagnosis || ocrPayload?.diagnosis || [],
      medications: ocrPayload?.medicalExtraction?.medications || ocrPayload?.medications || [],
      labResults: ocrPayload?.medicalExtraction?.labResults || ocrPayload?.labResults || [],
      vitals: ocrPayload?.medicalExtraction?.vitals || ocrPayload?.vitals || [],
      recommendations:
        ocrPayload?.medicalExtraction?.recommendations || ocrPayload?.recommendations || [],
      summary: ocrPayload?.medicalExtraction?.summary || ocrPayload?.summary || "",
      prescriptions: ocrPayload?.prescriptions || [],
      sections: ocrPayload?.sections || [],
      tables: ocrPayload?.tables || [],
    };

    const medications = buildMedications(normalized);

    let summaryText = normalized.summary;
    if (!summaryText) {
      summaryText = normalized.fullText
        ? normalized.fullText.slice(0, 500)
        : "No summary available.";
    }

    const summary = {
      summary: summaryText,
      documentType: ocrPayload?.documentType || null,
      diagnosis: normalized.diagnosis,
      medications,
      keyFindings: normalized.diagnosis,
      followUps: normalized.recommendations,
      recommendations: normalized.recommendations,
    };

    const allergyEntities = pickEntities(normalized.medicalEntities, "allergy");
    const bloodGroupEntities = pickEntities(normalized.medicalEntities, "blood_group");
    const labResults = buildLabResults(normalized);
    const doctorName =
      asObject(normalized.doctorInfo).name ||
      pickFirstField(normalized.prescriptions, "doctorName") ||
      pickEntities(normalized.medicalEntities, "doctor_name")[0]?.name ||
      null;
    const hospitalName =
      asObject(normalized.hospitalInfo).name ||
      pickFirstField(normalized.sections, "hospitalName") ||
      null;
    const patientName =
      asObject(normalized.patientInfo).name ||
      normalized.patientName ||
      pickEntities(normalized.medicalEntities, "patient_name")[0]?.name ||
      patientContext?.fullName ||
      null;
    const diagnosis = buildDiagnosis(normalized, summary);
    const recommendations = uniqueStrings([
      ...asArray(normalized.recommendations).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v),
      ),
      ...asArray(summary?.followUps).map((v) => (typeof v === "string" ? v : JSON.stringify(v))),
      ...asArray(summary?.recommendations).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v),
      ),
    ]);
    const finalSummary = summary?.summary || normalized.summary || "";

    const structured = {
      patientInfo: {
        ...asObject(normalized.patientInfo),
        ...(patientName ? { name: patientName } : {}),
      },
      hospitalInfo: {
        ...asObject(normalized.hospitalInfo),
        ...(hospitalName ? { name: hospitalName } : {}),
      },
      doctorInfo: {
        ...asObject(normalized.doctorInfo),
        ...(doctorName ? { name: doctorName } : {}),
      },
      diagnosis,
      medications,
      labResults,
      vitals: buildVitals(normalized),
      recommendations,
      summary: finalSummary,

      allergies: uniqueStrings(allergyEntities.map((e) => e.value || e.name)),
      bloodGroup: bloodGroupEntities[0]?.value || bloodGroupEntities[0]?.name || null,
      diagnosisText: joinForText(diagnosis),
      doctorName,
      hospitalName,
      observations: asArray(summary?.keyFindings || summary?.observations).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      ),
      patientName,
      reportDate: pickReportDate(normalized),
      reportType: summary?.documentType || normalized?.documentType || null,
      testResults: labResults,
    };

    const rawOcrData = {
      blocks: ocrPayload?.paragraphs || [],
      confidence: ocrPayload?.confidence ?? rawOcr?.metadata?.confidence ?? null,
      engine: rawOcr?.metrics?.engine || "pymupdf",
      fullText: ocrPayload?.fullText || ocrPayload?.text || rawOcr?.ocr_text || "",
      language: ocrPayload?.language || null,
      metrics: rawOcr?.metrics || {},
      pageCount: ocrPayload?.pageCount || rawOcr?.metadata?.pageCount || 0,
      pages: ocrPayload?.pages || [],
      processingSeconds: rawOcr?.metrics?.processing_seconds ?? null,
      tables: ocrPayload?.tables || [],
      usedDirectText: !!rawOcr?.metrics?.used_direct_text,
      usedOcr: !!rawOcr?.metrics?.used_ocr,
      usedQwenVl: !!rawOcr?.metrics?.used_qwen_vl,
    };

    return { normalized, rawOcrData, structured, summary };
  }
}

module.exports = new MedicalExtractionService();
