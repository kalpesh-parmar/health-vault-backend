const { sql } = require("drizzle-orm");
const { db } = require("../configs/db");
const { env } = require("../configs/env");
const { normalizeDocumentType } = require("../enums/documentType");
// const { fileTypeValue } = require("../enums/fileType");
const { messageConstants } = require("../constants/messageConstants");
const { ocrStatus } = require("../enums/ocrStatus");
const { InvalidRequestException, NotFoundException } = require("../exceptions/appError");
const DocumentArtifactsRepository = require("../repositories/documentArtifactsRepository");
const documentIntelligenceRepository = require("../repositories/documentIntelligenceRepository");
const patientRepository = require("../repositories/patientRepository");
const medicationMapper = require("../helpers/medicationMapper.helper");
const objectStorageService = require("./objectStorage.service");
const { document } = require("../models/document");
const { medication } = require("../models/medication");
const { patientLabResult } = require("../models/patientLabResult");
const { embeddingService } = require("./ai/chat/embedding.service");
const { inferFileType, buildPatientSuggestions } = require("../helpers/document.helper");
const { toDbDate } = require("../utils/dateUtils");

function sanitizeGraphRow(graph, documentId, userId) {
  let graphType = "unknown";
  if (typeof graph?.graphType === "string") {
    const trimmed = graph.graphType.trim().toLowerCase();
    if (!trimmed.includes("|") && trimmed.length <= 64 && trimmed !== "unknown") {
      graphType = trimmed;
    }
  }

  let page = null;
  if (typeof graph?.page === "number" && Number.isInteger(graph.page)) {
    page = graph.page;
  } else if (typeof graph?.page === "string") {
    const trimmed = graph.page.trim();
    if (/^\d+$/.test(trimmed)) {
      page = parseInt(trimmed, 10);
    }
  }

  const sanitizeText = (val, maxLen = 255) => {
    if (!val || typeof val !== "string") return null;
    const trimmed = val.trim();
    if (
      /^(string\|null|number\|null|null|undefined|string|number|object)$/i.test(trimmed) ||
      /\|null/i.test(trimmed)
    ) {
      return null;
    }
    return trimmed.slice(0, maxLen) || null;
  };

  const sanitizeAxis = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((item) => {
      if (typeof item === "string") {
        const trimmed = item.trim();
        return !/^(string\|null|number\|null|\[.*\])$/i.test(trimmed) && !trimmed.includes("...");
      }
      return typeof item === "number" && !Number.isNaN(item);
    });
  };

  const sanitizeSeries = (series) => {
    if (!Array.isArray(series)) return [];
    return series
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        name: sanitizeText(s.name, 128) || "Series",
        values: sanitizeAxis(s.values),
      }));
  };

  return {
    documentId,
    graphType,
    metadata:
      typeof graph?.metadata === "object" &&
      graph?.metadata !== null &&
      !Array.isArray(graph.metadata)
        ? graph.metadata
        : {},
    page,
    series: sanitizeSeries(graph?.series),
    title: sanitizeText(graph?.title, 255),
    unit: sanitizeText(graph?.unit, 64),
    userId,
    xAxis: sanitizeAxis(graph?.xAxis),
    yAxis: sanitizeAxis(graph?.yAxis),
  };
}

class DocumentPersistenceService {
  async addDocument({ userId, payload }) {
    const { s3Key, extractedStructuredData } = payload;
    console.log("Payload size:", Buffer.byteLength(JSON.stringify(payload)), "bytes");
    if (!s3Key) {
      throw new InvalidRequestException(
        messageConstants.FILE_KEY_REQUIRED || "fileKey is required",
      );
    }

    try {
      await objectStorageService.getSignedFileUrl(s3Key);
    } catch {
      throw new NotFoundException(`File not found in storage: ${s3Key}`);
    }

    const patient = await patientRepository.findById(userId);
    if (!patient) throw new NotFoundException("Patient profile not found");

    const result = await db.transaction(async (tx) => {
      return this.addDocumentWithTx(tx, { userId, payload, patient });
    });

    return {
      document: result.document,
      embeddings: result.embeddings,
      medicationsCreated: result.medicationsCreated,
      medicationsSkipped: result.medicationsSkipped,
      patientSuggestions: buildPatientSuggestions(extractedStructuredData, patient),
    };
  }

  async addDocumentWithTx(tx, { userId, payload, patient = null }) {
    const {
      s3Key,
      rawOcrData,
      extractedStructuredData,
      graphs = [],
      embeddingsGenerated = false,
    } = payload;

    const patientObj = patient ||
      (await patientRepository.findById(userId)) || { patientCode: "P-TEMP" };

    const fileName = payload.fileName || s3Key.split("/").pop();
    const ext = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
    const inferredMime =
      ext === "pdf"
        ? "application/pdf"
        : ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : "application/pdf";
    const mimeType =
      payload.mimeType ||
      payload.fileType ||
      rawOcrData?.mimeType ||
      rawOcrData?.metrics?.mime_type ||
      inferredMime;

    const artifacts = new DocumentArtifactsRepository(tx);
    const intelligence = new documentIntelligenceRepository(tx);

    const bucketName =
      payload.s3bucket ||
      (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);

    // Strict requirement: report_date projection comes ONLY from explicit documentInfo.documentDate
    // NEVER use current date/time as fallback; if absent in document, remain null!
    const explicitDateStr =
      extractedStructuredData?.documentInfo?.documentDate ||
      extractedStructuredData?.reportDate ||
      payload.reportDate ||
      null;
    const projectedReportDate = explicitDateStr
      ? toDbDate(explicitDateStr, { documentId: s3Key })
      : null;

    // Strict requirement: hospital_name projection comes from facilityInfo.name
    const projectedHospitalName =
      extractedStructuredData?.facilityInfo?.name || extractedStructuredData?.hospitalName || null;

    // Strict requirement: doctor_name projection comes strictly from explicitly identified primary provider
    // If multiple providers exist without an explicit primary, remain null (never concatenate or guess)
    const primaryProvider =
      extractedStructuredData?.providerInfo?.primary?.name ||
      (Array.isArray(extractedStructuredData?.providerInfo?.providers) &&
      extractedStructuredData.providerInfo.providers.length === 1
        ? extractedStructuredData.providerInfo.providers[0].name
        : null);
    const projectedDoctorName = primaryProvider || extractedStructuredData?.doctorName || null;

    // Canonicalize structured extracted data contract
    let canonicalStructured = extractedStructuredData ? { ...extractedStructuredData } : null;
    if (canonicalStructured && typeof canonicalStructured === "object") {
      const summaryEng =
        canonicalStructured.summaryEnglish ||
        canonicalStructured.summary ||
        payload.summaryEnglish ||
        null;
      const summaryPref = canonicalStructured.summaryInPreferredLanguage || null;
      const summaryLang =
        canonicalStructured.summaryLanguage ||
        (summaryPref ? payload.preferredLanguage || "english" : "english");
      const prefLang =
        canonicalStructured.preferredLanguage ||
        payload.preferredLanguage ||
        summaryLang ||
        "english";

      canonicalStructured.summaryEnglish = summaryEng;
      if (summaryPref) {
        canonicalStructured.summaryInPreferredLanguage = summaryPref;
      }
      canonicalStructured.summaryLanguage = summaryLang;
      canonicalStructured.preferredLanguage = prefLang;
      canonicalStructured.summaryPipelineVersion =
        canonicalStructured.summaryPipelineVersion || "1.1.0";
      canonicalStructured.translationStatus =
        canonicalStructured.translationStatus || (summaryPref ? "translated" : "original");
      canonicalStructured.translationProvider =
        canonicalStructured.translationProvider || (summaryPref ? "medgemma" : "original");

      if (!canonicalStructured.summariesByLanguage) {
        canonicalStructured.summariesByLanguage = {
          english: summaryEng || "",
          en: summaryEng || "",
          ...(summaryPref && summaryLang !== "english" ? { [summaryLang]: summaryPref } : {}),
        };
      } else {
        if (!canonicalStructured.summariesByLanguage.english && summaryEng) {
          canonicalStructured.summariesByLanguage.english = summaryEng;
        }
        if (!canonicalStructured.summariesByLanguage.en && summaryEng) {
          canonicalStructured.summariesByLanguage.en = summaryEng;
        }
        if (
          summaryPref &&
          summaryLang !== "english" &&
          !canonicalStructured.summariesByLanguage[summaryLang]
        ) {
          canonicalStructured.summariesByLanguage[summaryLang] = summaryPref;
        }
      }

      if (!Array.isArray(canonicalStructured.keyPoints)) {
        canonicalStructured.keyPoints = [];
      }
      if (!canonicalStructured.keyFindings) {
        canonicalStructured.keyFindings = [];
      }
    }

    const [documentRow] = await tx
      .insert(document)
      .values({
        documentType: normalizeDocumentType(
          payload.documentType ||
            canonicalStructured?.documentInfo?.documentType ||
            canonicalStructured?.documentType ||
            canonicalStructured?.reportType,
        ),
        doctorName: projectedDoctorName,
        fileName,
        fileSize: payload.fileSize || rawOcrData?.fileSize || 0,
        fileType: inferFileType(mimeType),
        hospitalName: projectedHospitalName,
        ocrExtractedText: rawOcrData?.fullText || null,
        ocrStatus: ocrStatus.COMPLETED,
        remarks:
          canonicalStructured?.summaryInPreferredLanguage ||
          canonicalStructured?.summary ||
          canonicalStructured?.additionalInformation?.remarks ||
          null,
        reportDate: projectedReportDate,
        s3Bucket: bucketName,
        s3Key: s3Key,
        structuredExtractedData: canonicalStructured,
        userId,
        summaryEnglish: canonicalStructured?.summaryEnglish || null,
      })
      .onConflictDoUpdate({
        target: document.s3Key,
        set: {
          documentType: normalizeDocumentType(
            payload.documentType ||
              canonicalStructured?.documentInfo?.documentType ||
              canonicalStructured?.documentType ||
              canonicalStructured?.reportType,
          ),
          doctorName: projectedDoctorName || sql`${document.doctorName}`,
          fileName,
          fileSize: payload.fileSize || rawOcrData?.fileSize || sql`${document.fileSize}`,
          fileType: inferFileType(mimeType),
          hospitalName: projectedHospitalName || sql`${document.hospitalName}`,
          ocrExtractedText: rawOcrData?.fullText || sql`${document.ocrExtractedText}`,
          ocrStatus: ocrStatus.COMPLETED,
          remarks:
            canonicalStructured?.summaryInPreferredLanguage ||
            canonicalStructured?.summary ||
            canonicalStructured?.additionalInformation?.remarks ||
            sql`${document.remarks}`,
          reportDate: projectedReportDate || sql`${document.reportDate}`,
          s3Bucket: bucketName,
          structuredExtractedData: canonicalStructured || sql`${document.structuredExtractedData}`,
          summaryEnglish: canonicalStructured?.summaryEnglish || sql`${document.summaryEnglish}`,
          updatedAt: new Date(),
        },
      })
      .returning();

    const documentId = documentRow?.id || "doc_test";
    await artifacts.upsertOcrRaw({
      blocks: rawOcrData?.blocks || [],
      confidence: rawOcrData?.confidence != null ? Number(rawOcrData.confidence) : null,
      documentId,
      engine: rawOcrData?.engine || "pymupdf",
      fileKey: s3Key,
      fullText: rawOcrData?.fullText || null,
      language: rawOcrData?.language || null,
      metrics: rawOcrData?.metrics || {},
      pageCount: rawOcrData?.pageCount || 0,
      processingSeconds: rawOcrData?.processingSeconds || null,
      tables: rawOcrData?.tables || [],
      usedDirectText: !!rawOcrData?.usedDirectText,
      usedOcr: !!rawOcrData?.usedOcr,
      userId,
    });

    const ocrPages = Array.isArray(rawOcrData?.pages) ? rawOcrData.pages : [];
    await artifacts.replacePages(
      documentId,
      ocrPages.map((page, index) => ({
        blocks: page?.lines || [],
        confidence: page?.confidence != null ? Number(page.confidence) : null,
        documentId,
        metadata: { elapsed_ms: page?.elapsed_ms ?? null },
        pageNumber: page?.page || index + 1,
        rawText: page?.text || null,
        userId,
      })),
    );

    // Stop duplicate medical writes: retain strictly AI audit/execution metadata
    await artifacts.upsertAiSummary({
      aiModel: extractedStructuredData?.aiModel || null,
      aiProvider: extractedStructuredData?.aiProvider || null,
      documentId,
      rawAiResponse:
        extractedStructuredData?.rawSummary || extractedStructuredData?.rawAiResponse || null,
      userId,
    });

    const safeGraphs = Array.isArray(graphs) ? graphs : [];
    await artifacts.replaceGraphs(
      documentId,
      safeGraphs.map((graph) => sanitizeGraphRow(graph, documentId, userId)),
    );

    // Issue 4 Fix: If the caller provides confirmedMedicationIds (a list of medication
    // IDs/names the user explicitly selected during onboarding review), only those are
    // passed to the mapper for DB insertion. This prevents deselected AI-extracted
    // medications from being silently re-inserted via addDocument.
    // When confirmedMedicationIds is absent (undefined/null), all extracted medications
    // are used — preserving existing behavior for all non-onboarding callers.
    const allExtractedMedications = extractedStructuredData?.medications || [];
    const confirmedMedicationIds = payload?.confirmedMedicationIds;
    const medicationsToProcess = Array.isArray(confirmedMedicationIds)
      ? allExtractedMedications.filter((m) =>
          confirmedMedicationIds.includes(m.id || m.client_med_id || m.name),
        )
      : allExtractedMedications;

    const { rows: medicationRows, skipped: medicationSkipped } = medicationMapper.buildRows({
      defaults: {
        prescribedBy: projectedDoctorName || extractedStructuredData?.doctorName || null,
        startDate: projectedReportDate || new Date(),
      },
      medications: medicationsToProcess,
      patientCode: patientObj.patientCode,
      userId,
    });

    const insertedMedications = [];
    const skipMedications = !!payload?.skipMedications;
    if (!skipMedications) {
      for (const row of medicationRows) {
        if (row.clientMedId) {
          const [savedMed] = await tx
            .insert(medication)
            .values(row)
            .onConflictDoUpdate({
              target: [medication.userId, medication.clientMedId],
              set: {
                patientCode: row.patientCode,
                medicationName: row.medicationName,
                medicationType: row.medicationType,
                prescribedBy: row.prescribedBy,
                dosePerIntake: row.dosePerIntake,
                frequency: row.frequency,
                medicationSchedule: row.medicationSchedule,
                foodFrequency: row.foodFrequency,
                startDate: row.startDate,
                endDate: row.endDate,
                ongoing: row.ongoing,
                totalQuantity: row.totalQuantity,
                unit: row.unit,
                dailyConsumption: row.dailyConsumption,
                reminderBeforeMinutes: row.reminderBeforeMinutes,
                notes: row.notes,
                updatedAt: new Date(),
              },
            })
            .returning();
          insertedMedications.push(savedMed);
        } else {
          const [savedMed] = await tx.insert(medication).values(row).returning();
          insertedMedications.push(savedMed);
        }
      }
    }

    // Persist lab results to patient_lab_results if present in extracted structured data
    const rawLabs =
      extractedStructuredData?.labResults || extractedStructuredData?.labReports || [];
    if (Array.isArray(rawLabs) && rawLabs.length > 0) {
      try {
        const labRows = rawLabs.map((item) => ({
          userId,
          documentId,
          reportId: s3Key,
          canonicalKey:
            item.canonicalKey ||
            String(item.testName || item.name || "unknown_test")
              .toLowerCase()
              .replace(/[\s\-_]+/g, "_"),
          testName: String(item.testName || item.name || "Unknown Test"),
          valueNumeric:
            typeof item.valueNumeric === "number"
              ? item.valueNumeric
              : typeof item.value === "number"
                ? item.value
                : null,
          valueText: item.valueText || (item.value != null ? String(item.value) : null),
          unit: item.unit || null,
          referenceRange: item.referenceRange || null,
          flag: item.flag || "NORMAL",
          isAbnormal: Boolean(item.isAbnormal),
          isCritical: Boolean(item.isCritical),
          testDate: projectedReportDate || new Date(),
          pageNo: item.pageNo || item.page || 1,
          confidence: item.confidence != null ? Number(item.confidence) : null,
          metadata: item.metadata || {},
        }));
        await tx
          .insert(patientLabResult)
          .values(labRows)
          .catch(() => {});
      } catch {
        // non-blocking
      }
    }

    let embeddingResult = { chunkCount: 0, chunkIds: [], embeddings: 0 };
    if (!embeddingsGenerated) {
      embeddingResult = await embeddingService.embedAndPersist({
        documentId,
        rawOcr: rawOcrData,
        structured: extractedStructuredData,
        txRepository: intelligence,
        userId,
      });
    }

    return {
      document: documentRow,
      embeddings: embeddingResult,
      medicationsCreated: insertedMedications,
      medicationsSkipped: medicationSkipped,
    };
  }
}

module.exports = new DocumentPersistenceService();
