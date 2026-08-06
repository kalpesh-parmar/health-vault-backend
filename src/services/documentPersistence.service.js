const { db } = require("../configs/db");
const { env } = require("../configs/env");
const { normalizeDocumentType } = require("../enums/documentType");
const { fileTypeValue } = require("../enums/fileType");
const { messageConstants } = require("../constants/messageConstants");
const { ocrStatus } = require("../enums/ocrStatus");
const { InvalidRequestException, NotFoundException } = require("../exceptions/appError");
const DocumentArtifactsRepository = require("../repositories/documentArtifactsRepository");
const documentIntelligenceRepository = require("../repositories/documentIntelligenceRepository");
const patientRepository = require("../repositories/patientRepository");
const medicationMapper = require("./ai/helpers/medicationMapper");
const objectStorageService = require("./objectStorage.service");
const { document } = require("../models/document");
const { embeddingService } = require("./ai/chat/embedding.service");

function inferFileType(mimeType) {
  if (!mimeType) return fileTypeValue[0];
  if (fileTypeValue.includes(mimeType)) return mimeType;
  return fileTypeValue[0];
}

function buildPatientSuggestions(extracted, patient) {
  const suggestions = {};
  if (extracted?.bloodGroup && extracted.bloodGroup !== patient?.bloodGroup) {
    suggestions.bloodGroup = extracted.bloodGroup;
  }
  const extAllergies = Array.isArray(extracted?.allergies) ? extracted.allergies : [];
  const patAllergies = Array.isArray(patient?.allergies) ? patient.allergies : [];
  const newAllergies = extAllergies.filter(
    (allergy) =>
      allergy &&
      !patAllergies.some(
        (existing) => String(existing).toLowerCase() === String(allergy).toLowerCase(),
      ),
  );
  if (newAllergies.length) suggestions.allergies = newAllergies;
  return suggestions;
}

function asText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || null;
}

class DocumentPersistenceService {
  async addDocument({ userId, payload }) {
    const {
      s3Key,
      rawOcrData,
      extractedStructuredData,
      graphs = [],
      embeddingsGenerated = false,
    } = payload;
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

    const result = await db.transaction(async (tx) => {
      const artifacts = new DocumentArtifactsRepository(tx);
      const intelligence = new documentIntelligenceRepository(tx);

      const bucketName =
        payload.s3bucket ||
        (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);

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
          remarks: extractedStructuredData?.summary || null,
          reportDate: extractedStructuredData?.reportDate
            ? new Date(extractedStructuredData.reportDate)
            : null,
          s3Bucket: bucketName,
          s3Key: s3Key,
          structuredExtractedData: extractedStructuredData,
          userId,
          summaryEnglish: extractedStructuredData?.summaryEnglish || null,
          summaryInPreferredLanguage: extractedStructuredData?.summaryInPreferredLanguage || null,
        })
        .returning();

      const documentId = documentRow.id;
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
        reportDate: extractedStructuredData?.reportDate
          ? new Date(extractedStructuredData.reportDate)
          : null,
        reportType: extractedStructuredData?.reportType || null,
        summary: extractedStructuredData?.summary || null,
        testResults:
          extractedStructuredData?.testResults || extractedStructuredData?.labResults || [],
        userId,
      });

      const safeGraphs = Array.isArray(graphs) ? graphs : [];
      await artifacts.replaceGraphs(
        documentId,
        safeGraphs.map((graph) => ({
          documentId,
          graphType: graph.graphType || "unknown",
          metadata: graph.metadata || {},
          page: graph.page ?? null,
          series: graph.series || [],
          title: graph.title || null,
          unit: graph.unit || null,
          userId,
          xAxis: graph.xAxis || [],
          yAxis: graph.yAxis || [],
        })),
      );
      const { rows: medicationRows, skipped: medicationSkipped } = medicationMapper.buildRows({
        defaults: {
          prescribedBy: extractedStructuredData?.doctorName || null,
          startDate: extractedStructuredData?.reportDate
            ? new Date(extractedStructuredData.reportDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10),
        },
        medications: extractedStructuredData?.medications || [],
        patientCode: patient.patientCode,
        userId,
      });

      const insertedMedications = [];
      for (const row of medicationRows) {
        insertedMedications.push(await tx.insert("medications", row));
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
    });

    return {
      document: result.document,
      embeddings: result.embeddings,
      medicationsCreated: result.medicationsCreated,
      medicationsSkipped: result.medicationsSkipped,
      patientSuggestions: buildPatientSuggestions(extractedStructuredData, patient),
    };
  }
}

module.exports = new DocumentPersistenceService();
