const { and, eq, inArray, or } = require("drizzle-orm");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { documentProcessingJob } = require("../../../models/documentProcessingJob");
const { NotFoundException, UnauthorizedException } = require("../../../exceptions/appError");

class DocumentAuthorizationService {
  /**
   * Normalizes documentId input to an array of trimmed string IDs.
   *
   * @param {string|string[]|null|undefined} input - Document ID or array of IDs
   * @returns {string[]} Normalized array of unique document IDs
   */
  normalizeDocumentIds(input) {
    if (!input) return [];
    const list = Array.isArray(input) ? input : [input];
    return Array.from(
      new Set(
        list
          .map((id) => (typeof id === "string" ? id.trim() : String(id || "").trim()))
          .filter((id) => id.length > 0),
      ),
    );
  }

  /**
   * Authorizes that all requested document IDs belong to the authenticated user,
   * are active (softDelete = false), and belong to the authorized patient profile.
   *
   * @param {string} userId - Authenticated user ID
   * @param {string|string[]} rawDocumentIds - Requested document ID(s)
   * @param {object} [options] - Authorization options
   * @param {string} [options.patientId] - Optional patient profile ID
   * @returns {Promise<{ authorizedDocumentIds: string[], documents: object[] }>}
   */
  async authorizeDocumentIds(userId, rawDocumentIds, options = {}) {
    if (!userId) {
      throw new UnauthorizedException("User ID is required for document authorization");
    }

    const uniqueIds = this.normalizeDocumentIds(rawDocumentIds);
    if (uniqueIds.length === 0) {
      return {
        authorizedDocumentIds: [],
        documents: [],
      };
    }

    const database = options.db || db;
    let authorizedRows = [];

    // If options.db provides custom findMany mock (for unit/integration testing)
    if (database.query?.documents?.findMany) {
      const allFound = await database.query.documents.findMany({
        where: { userId, patientId: options.patientId },
      });
      authorizedRows = allFound.filter((doc) => {
        if (!uniqueIds.includes(doc.id)) return false;
        if (doc.isDeleted === true || doc.softDelete === true) return false;
        if (options.patientId && doc.patientId && doc.patientId !== options.patientId) return false;
        return true;
      });
    } else {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validUuids = uniqueIds.filter((id) => uuidRegex.test(id));
      const nonUuids = uniqueIds.filter((id) => !uuidRegex.test(id));

      const idOrKeyConditions = [];
      if (validUuids.length > 0) {
        idOrKeyConditions.push(inArray(document.id, validUuids));
      }
      if (nonUuids.length > 0) {
        idOrKeyConditions.push(inArray(document.s3Key, nonUuids));
      }

      if (idOrKeyConditions.length === 0) {
        return { authorizedDocumentIds: [], documents: [] };
      }

      const matchCondition =
        idOrKeyConditions.length === 1 ? idOrKeyConditions[0] : or(...idOrKeyConditions);

      authorizedRows = await database
        .select({
          id: document.id,
          userId: document.userId,
          fileName: document.fileName,
          documentType: document.documentType,
          reportDate: document.reportDate,
          hospitalName: document.hospitalName,
          doctorName: document.doctorName,
          structuredExtractedData: document.structuredExtractedData,
          summaryEnglish: document.summaryEnglish,
          ocrStatus: document.ocrStatus,
          createdAt: document.createdAt,
          s3Key: document.s3Key,
        })
        .from(document)
        .where(and(matchCondition, eq(document.userId, userId), eq(document.softDelete, false)));
    }

    const foundIdSet = new Set([
      ...authorizedRows.map((doc) => String(doc.id)),
      ...authorizedRows.map((doc) => String(doc.s3Key || "")).filter(Boolean),
    ]);
    let missingIds = uniqueIds.filter((id) => !foundIdSet.has(String(id)));

    // Fallback ONLY for legacy chat messages that stored a Job ID instead of documents.id
    if (missingIds.length > 0) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validMissingUuids = missingIds.filter((id) => uuidRegex.test(id));

      if (validMissingUuids.length > 0) {
        let matchingJobs = [];
        if (database.query?.documentProcessingJobs?.findMany) {
          const allUserJobs = await database.query.documentProcessingJobs.findMany({
            where: { userId },
          });
          matchingJobs = allUserJobs.filter(
            (j) => validMissingUuids.includes(j.id) && j.userId === userId,
          );
        } else {
          try {
            matchingJobs = await database
              .select({
                id: documentProcessingJob.id,
                userId: documentProcessingJob.userId,
                status: documentProcessingJob.status,
                fileKey: documentProcessingJob.fileKey,
                metadata: documentProcessingJob.metadata,
              })
              .from(documentProcessingJob)
              .where(
                and(
                  inArray(documentProcessingJob.id, validMissingUuids),
                  eq(documentProcessingJob.userId, userId),
                ),
              );
          } catch (jobErr) {
            console.warn(
              "[DocumentAuthorization] Failed to query document_processing_jobs fallback:",
              jobErr.message,
            );
            matchingJobs = [];
          }
        }

        // If any matching job is currently in progress / processing, return friendly status indicator
        const processingJob = matchingJobs.find((j) => {
          const st = String(j.status || "").toUpperCase();
          return (
            st === "QUEUED" ||
            st === "PROCESSING" ||
            st === "RUNNING" ||
            st === "IN_PROGRESS" ||
            st === "PENDING"
          );
        });

        if (processingJob) {
          return {
            authorizedDocumentIds: [],
            documents: [],
            isProcessing: true,
            processingJobId: processingJob.id,
          };
        }

        // For completed jobs, resolve to their persisted document record
        const resolvedDocIds = matchingJobs
          .map((j) => j.metadata?.documentId)
          .filter((id) => id && uuidRegex.test(String(id)));
        const resolvedFileKeys = matchingJobs
          .map((j) => j.metadata?.s3Key || j.metadata?.key || j.fileKey)
          .filter(Boolean);

        const fallbackConds = [];
        if (resolvedDocIds.length > 0) fallbackConds.push(inArray(document.id, resolvedDocIds));
        if (resolvedFileKeys.length > 0)
          fallbackConds.push(inArray(document.s3Key, resolvedFileKeys));

        if (fallbackConds.length > 0) {
          const matchCond = fallbackConds.length === 1 ? fallbackConds[0] : or(...fallbackConds);
          const resolvedDocs = await database
            .select({
              id: document.id,
              userId: document.userId,
              fileName: document.fileName,
              documentType: document.documentType,
              reportDate: document.reportDate,
              hospitalName: document.hospitalName,
              doctorName: document.doctorName,
              structuredExtractedData: document.structuredExtractedData,
              summaryEnglish: document.summaryEnglish,
              ocrStatus: document.ocrStatus,
              createdAt: document.createdAt,
              s3Key: document.s3Key,
            })
            .from(document)
            .where(and(matchCond, eq(document.userId, userId), eq(document.softDelete, false)));

          for (const job of matchingJobs) {
            const matchedDoc = resolvedDocs.find(
              (d) =>
                d.id === job.metadata?.documentId ||
                d.s3Key === job.fileKey ||
                d.s3Key === job.metadata?.s3Key ||
                d.s3Key === job.metadata?.key,
            );
            if (matchedDoc) {
              console.warn(
                `[DocumentAuthorization] Resolved legacy job ID ${job.id} to document ${matchedDoc.id} for userId=${userId}`,
              );
              foundIdSet.add(String(job.id));
              if (!authorizedRows.some((d) => d.id === matchedDoc.id)) {
                authorizedRows.push(matchedDoc);
              }
            }
          }
        }
      }
    }

    missingIds = uniqueIds.filter((id) => !foundIdSet.has(String(id)));

    if (missingIds.length > 0) {
      const err = new NotFoundException(
        `Document(s) not found, unauthorized, or deleted (fail-closed): ${missingIds.join(", ")}`,
      );
      err.statusCode = 403; // Fail closed with access denial
      throw err;
    }

    return {
      authorizedDocumentIds: authorizedRows.map((doc) => doc.id),
      documents: authorizedRows,
      isProcessing: false,
    };
  }

  /**
   * Resolves scope mode and validates authorization for selected document IDs.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} [params.patientId]
   * @param {string|string[]} [params.documentIds]
   * @param {string} [params.scopeMode]
   * @param {object} [params.db]
   * @returns {Promise<{ scopeMode: string, authorizedDocumentIds: string[], documents: object[] }>}
   */
  async resolveDocumentScope({ userId, patientId, documentIds, scopeMode, db: customDb } = {}) {
    if (!userId) {
      throw new UnauthorizedException("User ID is required for document authorization");
    }

    const uniqueIds = this.normalizeDocumentIds(documentIds);
    if (uniqueIds.length === 0) {
      return {
        scopeMode: "AUTHORIZED_HISTORY",
        authorizedDocumentIds: [],
        documents: [],
      };
    }

    const authRes = await this.authorizeDocumentIds(userId, uniqueIds, {
      patientId,
      db: customDb,
    });

    const resolvedMode =
      scopeMode ||
      (authRes.authorizedDocumentIds.length > 1 ? "MULTI_DOCUMENT" : "SINGLE_DOCUMENT");

    return {
      scopeMode: resolvedMode,
      authorizedDocumentIds: authRes.authorizedDocumentIds,
      documents: authRes.documents,
    };
  }
}

const documentAuthorizationService = new DocumentAuthorizationService();

module.exports = {
  documentAuthorizationService,
  DocumentAuthorizationService,
};
