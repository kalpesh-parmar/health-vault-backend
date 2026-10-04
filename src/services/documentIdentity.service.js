const { and, eq, sql } = require("drizzle-orm");
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { documentProcessingJob } = require("../models/documentProcessingJob");
const { ocrStatus } = require("../enums/ocrStatus");
const { documentType } = require("../enums/documentType");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class DocumentIdentityService {
  isUuid(val) {
    return typeof val === "string" && UUID_REGEX.test(val.trim());
  }

  isLogicalFileKey(val) {
    if (typeof val !== "string") return false;
    const trimmed = val.trim();
    return (
      trimmed.startsWith("doc_") ||
      (!this.isUuid(trimmed) && !trimmed.includes("/") && trimmed.length > 0)
    );
  }

  /**
   * Sync extracted data from a completed job into the canonical documents row.
   */
  async syncJobToDocument(job, documentId) {
    if (!job || !documentId) return null;
    const isCompleted = job.status === "COMPLETED";
    const structuredData = job.extractedStructuredData || null;
    const rawText = job.rawOcrData?.fullText || null;

    if (!isCompleted && !structuredData) return null;

    try {
      const [updated] = await db
        .update(document)
        .set({
          ocrStatus: isCompleted ? ocrStatus.COMPLETED : ocrStatus.IN_PROGRESS,
          ...(structuredData ? { structuredExtractedData: structuredData } : {}),
          ...(rawText ? { ocrExtractedText: rawText } : {}),
          updatedAt: new Date(),
        })
        .where(eq(document.id, documentId))
        .returning();
      return updated || null;
    } catch (err) {
      console.warn("[DocumentIdentityService] syncJobToDocument failed:", err.message);
      return null;
    }
  }

  /**
   * Authoritatively resolve canonical document record from DB without guessing or blind LIMIT 1.
   */
  async resolveCanonicalDocument({ documentIdOrFileKey, userId }) {
    if (!documentIdOrFileKey) return null;

    const trimmed = String(documentIdOrFileKey).trim();
    let canonicalDoc = null;
    let matchingJob = null;

    // 1. If input is a logical fileKey (e.g. "doc_...")
    if (this.isLogicalFileKey(trimmed)) {
      const jobConditions = [eq(documentProcessingJob.fileKey, trimmed)];
      if (userId) jobConditions.push(eq(documentProcessingJob.userId, userId));

      const [job] = await db
        .select()
        .from(documentProcessingJob)
        .where(and(...jobConditions))
        .limit(1);

      if (job) {
        matchingJob = job;
        const targetDocId = job.checkpointData?.documentId || job.metadata?.documentId || null;
        if (targetDocId && this.isUuid(targetDocId)) {
          const docConditions = [eq(document.id, targetDocId)];
          if (userId) docConditions.push(eq(document.userId, userId));
          const [doc] = await db
            .select()
            .from(document)
            .where(and(...docConditions))
            .limit(1);
          canonicalDoc = doc || null;
        }

        // Fallback: match by s3Key if targetDocId not found
        if (!canonicalDoc) {
          const s3Key = job.checkpointData?.s3Key || job.metadata?.s3Key || job.metadata?.key;
          if (s3Key) {
            const docConditions = [eq(document.s3Key, s3Key)];
            if (userId) docConditions.push(eq(document.userId, userId));
            const [doc] = await db
              .select()
              .from(document)
              .where(and(...docConditions))
              .limit(1);
            canonicalDoc = doc || null;
          }
        }
      }
    } else if (this.isUuid(trimmed)) {
      // 2. Input is a UUID. Check if it directly matches documents.id
      const docConditions = [eq(document.id, trimmed)];
      if (userId) docConditions.push(eq(document.userId, userId));
      const [doc] = await db
        .select()
        .from(document)
        .where(and(...docConditions))
        .limit(1);

      if (doc) {
        canonicalDoc = doc;
        // Optionally find corresponding job to verify sync
        const jobConditions = [
          sql`(${documentProcessingJob.checkpointData}->>'documentId' = ${trimmed} OR ${documentProcessingJob.metadata}->>'documentId' = ${trimmed})`,
        ];
        if (userId) jobConditions.push(eq(documentProcessingJob.userId, userId));
        const [job] = await db
          .select()
          .from(documentProcessingJob)
          .where(and(...jobConditions))
          .limit(1);
        matchingJob = job || null;
      } else {
        // Check if the UUID was actually a jobId from document_processing_jobs
        const jobConditions = [eq(documentProcessingJob.id, trimmed)];
        if (userId) jobConditions.push(eq(documentProcessingJob.userId, userId));
        const [job] = await db
          .select()
          .from(documentProcessingJob)
          .where(and(...jobConditions))
          .limit(1);

        if (job) {
          matchingJob = job;
          const targetDocId = job.checkpointData?.documentId || job.metadata?.documentId || null;
          if (targetDocId && this.isUuid(targetDocId)) {
            const docConditions = [eq(document.id, targetDocId)];
            if (userId) docConditions.push(eq(document.userId, userId));
            const [matchedDoc] = await db
              .select()
              .from(document)
              .where(and(...docConditions))
              .limit(1);
            canonicalDoc = matchedDoc || null;
          }
        }
      }
    }

    // 3. If job is completed but canonicalDoc is missing extractedStructuredData, sync it now
    if (canonicalDoc && matchingJob) {
      if (
        matchingJob.status === "COMPLETED" &&
        matchingJob.extractedStructuredData &&
        (!canonicalDoc.structuredExtractedData || canonicalDoc.ocrStatus !== ocrStatus.COMPLETED)
      ) {
        const synced = await this.syncJobToDocument(matchingJob, canonicalDoc.id);
        if (synced) canonicalDoc = synced;
      }
    }

    // 4. If job exists with extraction data but no documents row existed yet, create/upsert it
    if (!canonicalDoc && matchingJob && matchingJob.status === "COMPLETED") {
      const docId =
        (matchingJob.checkpointData?.documentId &&
          this.isUuid(matchingJob.checkpointData.documentId) &&
          matchingJob.checkpointData.documentId) ||
        (matchingJob.metadata?.documentId &&
          this.isUuid(matchingJob.metadata.documentId) &&
          matchingJob.metadata.documentId) ||
        matchingJob.id;
      const s3Key =
        matchingJob.checkpointData?.s3Key ||
        matchingJob.metadata?.s3Key ||
        matchingJob.metadata?.key ||
        matchingJob.fileKey;
      const bucket =
        matchingJob.checkpointData?.s3Bucket ||
        matchingJob.metadata?.bucket ||
        "health-vault-documents";
      const fileName = matchingJob.metadata?.originalName || s3Key.split("/").pop();

      try {
        const [upserted] = await db
          .insert(document)
          .values({
            id: docId,
            userId: matchingJob.userId,
            documentType: documentType.OTHER_MEDICAL_DOCUMENT,
            fileName,
            s3Bucket: bucket,
            s3Key,
            fileType: "application/pdf",
            fileSize: 0,
            ocrStatus: ocrStatus.COMPLETED,
            structuredExtractedData: matchingJob.extractedStructuredData || null,
            ocrExtractedText: matchingJob.rawOcrData?.fullText || null,
          })
          .onConflictDoUpdate({
            target: document.s3Key,
            set: {
              ocrStatus: ocrStatus.COMPLETED,
              structuredExtractedData: matchingJob.extractedStructuredData || null,
              ocrExtractedText: matchingJob.rawOcrData?.fullText || null,
              updatedAt: new Date(),
            },
          })
          .returning();
        canonicalDoc = upserted || null;
      } catch (err) {
        console.warn("[DocumentIdentityService] Fallback document upsert failed:", err.message);
      }
    }

    return canonicalDoc;
  }
}

module.exports = new DocumentIdentityService();
module.exports.DocumentIdentityService = DocumentIdentityService;
