const {
  DocumentAuthorizationService,
} = require("../../src/services/ai/chat/documentAuthorization.service");
const { NotFoundException, UnauthorizedException } = require("../../src/exceptions/appError");
const { documentProcessingJob } = require("../../src/models/documentProcessingJob");
const { DOCUMENT_STILL_PROCESSING_I18N } = require("../../src/constants/chatReplies");

describe("DocumentAuthorizationService", () => {
  let service;

  beforeEach(() => {
    service = new DocumentAuthorizationService();
  });

  describe("normalizeDocumentIds", () => {
    it("returns empty array for falsy input", () => {
      expect(service.normalizeDocumentIds(null)).toEqual([]);
      expect(service.normalizeDocumentIds(undefined)).toEqual([]);
      expect(service.normalizeDocumentIds("")).toEqual([]);
      expect(service.normalizeDocumentIds([])).toEqual([]);
    });

    it("normalizes a single string ID to a trimmed array", () => {
      expect(service.normalizeDocumentIds(" doc-123 ")).toEqual(["doc-123"]);
    });

    it("deduplicates and trims arrays of IDs", () => {
      const input = [" doc-1 ", "doc-2", "doc-1 ", ""];
      expect(service.normalizeDocumentIds(input)).toEqual(["doc-1", "doc-2"]);
    });
  });

  describe("authorizeDocumentIds", () => {
    it("throws UnauthorizedException if userId is missing", async () => {
      await expect(service.authorizeDocumentIds(null, ["doc-1"])).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns empty results when documentIds input is empty", async () => {
      const res = await service.authorizeDocumentIds("user-1", []);
      expect(res).toEqual({ authorizedDocumentIds: [], documents: [] });
    });

    it("authorizes valid active documents owned by the user", async () => {
      const mockDocs = [
        { id: "doc-1", userId: "user-1", softDelete: false, fileName: "Report1.pdf" },
        { id: "doc-2", userId: "user-1", softDelete: false, fileName: "Report2.pdf" },
      ];

      // Spy on db.select().from().where()
      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      const res = await service.authorizeDocumentIds("user-1", ["doc-1", "doc-2"]);
      expect(res.authorizedDocumentIds).toEqual(["doc-1", "doc-2"]);
      expect(res.documents.length).toBe(2);

      dbSelectSpy.mockRestore();
    });

    it("throws NotFoundException if any requested document is not found or soft-deleted", async () => {
      // User requested doc-1 and doc-2, but db only returns doc-1 (doc-2 is deleted or another user's)
      const mockDocs = [
        { id: "doc-1", userId: "user-1", softDelete: false, fileName: "Report1.pdf" },
      ];

      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      await expect(service.authorizeDocumentIds("user-1", ["doc-1", "doc-2"])).rejects.toThrow(
        NotFoundException,
      );

      dbSelectSpy.mockRestore();
    });

    it("(1) documents.id authorized: authorizes valid active document by canonical documents.id", async () => {
      const docUuid = "98765432-1111-2222-3333-444455556666";
      const mockDocs = [
        { id: docUuid, userId: "user-1", softDelete: false, fileName: "Report.pdf" },
      ];

      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      const res = await service.authorizeDocumentIds("user-1", [docUuid]);
      expect(res.authorizedDocumentIds).toEqual([docUuid]);
      expect(res.documents[0].id).toBe(docUuid);
      expect(res.isProcessing).toBe(false);

      dbSelectSpy.mockRestore();
    });

    it("(2) legacy job id resolved for the owner: falls back to document_processing_jobs and resolves document", async () => {
      const jobUuid = "11111111-2222-3333-4444-555555555555";
      const docUuid = "22222222-3333-4444-5555-666666666666";
      const mockJob = {
        id: jobUuid,
        userId: "user-1",
        status: "COMPLETED",
        fileKey: "uploads/user-1/report.pdf",
        metadata: { documentId: docUuid },
      };
      const mockDoc = {
        id: docUuid,
        userId: "user-1",
        softDelete: false,
        fileName: "Report.pdf",
        s3Key: "uploads/user-1/report.pdf",
      };

      let docQueryCount = 0;
      const dbSelectSpy = jest
        .spyOn(require("../../src/configs/db").db, "select")
        .mockImplementation(() => ({
          from: jest.fn().mockImplementation((table) => ({
            where: jest.fn().mockImplementation(async () => {
              if (table === documentProcessingJob) {
                return [mockJob];
              }
              // First document lookup (by jobUuid) returns empty; second (by resolved docUuid) returns mockDoc
              docQueryCount++;
              if (docQueryCount === 1) return [];
              return [mockDoc];
            }),
          })),
        }));

      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      const res = await service.authorizeDocumentIds("user-1", [jobUuid]);
      expect(res.authorizedDocumentIds).toEqual([docUuid]);
      expect(res.documents[0].id).toBe(docUuid);
      expect(res.isProcessing).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Resolved legacy job ID ${jobUuid} to document ${docUuid}`),
      );

      warnSpy.mockRestore();
      dbSelectSpy.mockRestore();
    });

    it("(3) job id of ANOTHER user rejected: fails closed with NotFoundException (403)", async () => {
      const otherUserJobUuid = "33333333-4444-5555-6666-777777777777";

      // Neither documents nor document_processing_jobs query for user-1 returns any match
      const dbSelectSpy = jest
        .spyOn(require("../../src/configs/db").db, "select")
        .mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }));

      await expect(service.authorizeDocumentIds("user-1", [otherUserJobUuid])).rejects.toThrow(
        NotFoundException,
      );

      dbSelectSpy.mockRestore();
    });

    it("(4) PROCESSING job returns friendly message: returns isProcessing: true and validates localized strings", async () => {
      const processingJobUuid = "44444444-5555-6666-7777-888888888888";
      const mockJob = {
        id: processingJobUuid,
        userId: "user-1",
        status: "PROCESSING",
        metadata: {},
      };

      const dbSelectSpy = jest
        .spyOn(require("../../src/configs/db").db, "select")
        .mockImplementation(() => ({
          from: jest.fn().mockImplementation((table) => ({
            where: jest.fn().mockImplementation(async () => {
              if (table === documentProcessingJob) {
                return [mockJob];
              }
              return [];
            }),
          })),
        }));

      const res = await service.authorizeDocumentIds("user-1", [processingJobUuid]);
      expect(res.isProcessing).toBe(true);
      expect(res.processingJobId).toBe(processingJobUuid);
      expect(res.authorizedDocumentIds).toEqual([]);

      // Verify friendly localized message exists in all 5 languages
      const languages = ["gu", "hi", "en", "ta", "mr"];
      for (const lang of languages) {
        expect(DOCUMENT_STILL_PROCESSING_I18N[lang]).toBeDefined();
        expect(typeof DOCUMENT_STILL_PROCESSING_I18N[lang]).toBe("string");
        expect(DOCUMENT_STILL_PROCESSING_I18N[lang].length).toBeGreaterThan(10);
      }

      dbSelectSpy.mockRestore();
    });
  });
});
