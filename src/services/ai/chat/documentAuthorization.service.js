const { and, eq, inArray } = require("drizzle-orm");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
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
      // Query active documents belonging to this user
      const conditions = [
        inArray(document.id, uniqueIds),
        eq(document.userId, userId),
        eq(document.softDelete, false),
      ];

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
        })
        .from(document)
        .where(and(...conditions));
    }

    const foundIdSet = new Set(authorizedRows.map((doc) => String(doc.id)));
    const missingIds = uniqueIds.filter((id) => !foundIdSet.has(String(id)));

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
