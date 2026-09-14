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
const { embeddingService } = require("./ai/chat/embedding.service");
const { inferFileType, buildPatientSuggestions, asText } = require("../helpers/document.helper");
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

    // Resolve date ONCE above queries to prevent insert/upsert drift
    const reportDateOrNull = toDbDate(extractedStructuredData?.reportDate, { documentId: s3Key });
    const reportDateOrNow = reportDateOrNull ?? new Date();

    const [documentRow] = await tx
      .insert(document)
      .values({
        documentType: normalizeDocumentType(
          payload.documentType ||
            extractedStructuredData?.documentType ||
            extractedStructuredData?.reportType,
        ),
        doctorName: extractedStructuredData?.doctorName || null,
        fileName,
        fileSize: payload.fileSize || rawOcrData?.fileSize || 0,
        fileType: inferFileType(mimeType),
        hospitalName: extractedStructuredData?.hospitalName || null,
        ocrExtractedText: rawOcrData?.fullText || null,
        ocrStatus: ocrStatus.COMPLETED,
        remarks:
          extractedStructuredData?.summaryInPreferredLanguage ||
          extractedStructuredData?.summary ||
          null,
        reportDate: reportDateOrNow,
        s3Bucket: bucketName,
        s3Key: s3Key,
        structuredExtractedData: extractedStructuredData,
        userId,
        summaryEnglish: extractedStructuredData?.summaryEnglish || null,
      })
      .onConflictDoUpdate({
        target: document.s3Key,
        set: {
          documentType: normalizeDocumentType(
            payload.documentType ||
              extractedStructuredData?.documentType ||
              extractedStructuredData?.reportType,
          ),
          doctorName: extractedStructuredData?.doctorName || null,
          fileName,
          fileSize: payload.fileSize || rawOcrData?.fileSize || 0,
          fileType: inferFileType(mimeType),
          hospitalName: extractedStructuredData?.hospitalName || null,
          ocrExtractedText: rawOcrData?.fullText || null,
          ocrStatus: ocrStatus.COMPLETED,
          remarks:
            extractedStructuredData?.summaryInPreferredLanguage ||
            extractedStructuredData?.summary ||
            null,
          reportDate: reportDateOrNow,
          s3Bucket: bucketName,
          structuredExtractedData: extractedStructuredData,
          summaryEnglish: extractedStructuredData?.summaryEnglish || null,
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

    await artifacts.upsertAiSummary({
      aiModel: extractedStructuredData?.aiModel || null,
      aiProvider: extractedStructuredData?.aiProvider || null,
      allergies: extractedStructuredData?.allergies || [],
      bloodGroup: extractedStructuredData?.bloodGroup || null,
      diagnosis:
        extractedStructuredData?.diagnosisText || asText(extractedStructuredData?.diagnosis),
      doctorName: extractedStructuredData?.doctorName || null,
      documentId,
      hospitalName: extractedStructuredData?.hospitalName || null,
      medications: extractedStructuredData?.medications || [],
      observations: extractedStructuredData?.observations || [],
      patientName: extractedStructuredData?.patientName || null,
      rawAiResponse: extractedStructuredData?.rawSummary || null,
      recommendations: extractedStructuredData?.recommendations || [],
      reportDate: reportDateOrNull,
      reportType: extractedStructuredData?.reportType || null,
      summary:
        extractedStructuredData?.summaryInPreferredLanguage ||
        extractedStructuredData?.summary ||
        null,
      testResults:
        extractedStructuredData?.testResults || extractedStructuredData?.labResults || [],
      userId,
    });

    const safeGraphs = Array.isArray(graphs) ? graphs : [];
    await artifacts.replaceGraphs(
      documentId,
      safeGraphs.map((graph) => sanitizeGraphRow(graph, documentId, userId)),
    );

    const { rows: medicationRows, skipped: medicationSkipped } = medicationMapper.buildRows({
      defaults: {
        prescribedBy: extractedStructuredData?.doctorName || null,
        startDate: reportDateOrNow,
      },
      medications: extractedStructuredData?.medications || [],
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
