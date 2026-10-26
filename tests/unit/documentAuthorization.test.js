const {
  DocumentAuthorizationService,
} = require("../../src/services/ai/chat/documentAuthorization.service");
const { NotFoundException, UnauthorizedException } = require("../../src/exceptions/appError");

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
  });
});
