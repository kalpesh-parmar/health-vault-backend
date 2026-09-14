const fs = require("fs");
const path = require("path");
const { StatusCodes } = require("http-status-codes");
const { validateDocumentRetry } = require("../../src/validations/uploadValidation");
const { retryDocument } = require("../../src/controllers/document.controller");
const documentService = require("../../src/services/document.service");
const { getAdaptiveStageTimeout, STAGES_PIPELINE } = require("../../src/services/document.service");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");
const { InvalidRequestException } = require("../../src/exceptions/appError");
const { errorConstants } = require("../../src/constants/errorConstants");
const { messageConstants } = require("../../src/constants/messageConstants");

jest.mock("../../src/services/document.service", () => {
  const actual = jest.requireActual("../../src/services/document.service");
  return {
    ...actual,
    retryDocument: jest.fn(),
  };
});

describe("Phase 8: Retry Hardening, Schema Wiring & Dead-Code Elimination", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("1. validateDocumentRetry Middleware (REQ-08, REQ-09)", () => {
    test("should pass validation when fileKey is provided in req.body", async () => {
      const req = {
        body: { fileKey: "patient_123/doc_abc.pdf" },
        query: {},
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(req.validatedRetry).toBeDefined();
      expect(req.validatedRetry.fileKey).toBe("patient_123/doc_abc.pdf");
      expect(req.body.fileKey).toBe("patient_123/doc_abc.pdf");
    });

    test("should pass validation when fileKey is provided in req.query", async () => {
      const req = {
        body: {},
        query: { fileKey: "patient_123/doc_xyz.pdf", batchId: "batch-456" },
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(req.validatedRetry.fileKey).toBe("patient_123/doc_xyz.pdf");
      expect(req.validatedRetry.batchId).toBe("batch-456");
      expect(req.query.fileKey).toBe("patient_123/doc_xyz.pdf");
    });

    test("should reject request with InvalidRequestException when fileKey is missing from both body and query", async () => {
      const req = {
        body: {},
        query: {},
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(InvalidRequestException);
      expect(error.message).toBe(errorConstants.FILE_KEY_REQUIRED);
    });

    test("should reject request with InvalidRequestException when fileKey is whitespace only", async () => {
      const req = {
        body: { fileKey: "   " },
        query: {},
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(InvalidRequestException);
      expect(error.message).toBe(errorConstants.FILE_KEY_REQUIRED);
    });

    test("should validate re-uploaded file attachment successfully if valid pdf", async () => {
      const req = {
        body: { fileKey: "patient_123/doc_reupload.pdf" },
        query: {},
        file: {
          originalname: "reuploaded_report.pdf",
          mimetype: "application/pdf",
          size: 1024 * 500, // 500 KB
        },
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    test("should reject and unlink invalid file type attachment", async () => {
      const tempPath = path.resolve(__dirname, "scratch_test_invalid.txt");
      fs.writeFileSync(tempPath, "not a medical document");

      const req = {
        body: { fileKey: "patient_123/doc_invalid.pdf" },
        query: {},
        file: {
          originalname: "bad_file.txt",
          mimetype: "text/plain",
          size: 100,
          path: tempPath,
        },
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentRetry(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(InvalidRequestException);
      expect(error.message).toMatch(/Invalid file bad_file.txt/);

      // Verify temp file was deleted
      expect(fs.existsSync(tempPath)).toBe(false);
    });
  });

  describe("2. documentController.retryDocument (REQ-09)", () => {
    test("should invoke documentService.retryDocument with fileKey from req.body", async () => {
      const mockResult = {
        jobId: "job-123",
        fileKey: "doc-body-key.pdf",
        status: "RUNNING",
        resumeStage: DOCUMENT_STAGES.OCR_RUNNING,
        progress: 15,
        streamUrl: "/sse/files/doc-body-key.pdf/stream",
      };
      documentService.retryDocument.mockResolvedValueOnce(mockResult);

      const req = {
        body: { fileKey: "doc-body-key.pdf" },
        query: {},
        auth: { userId: "user-999" },
        file: null,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await retryDocument(req, res);

      expect(documentService.retryDocument).toHaveBeenCalledWith({
        fileKey: "doc-body-key.pdf",
        userId: "user-999",
        file: null,
      });
      expect(res.status).toHaveBeenCalledWith(StatusCodes.ACCEPTED);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockResult,
          status: expect.objectContaining({
            description: messageConstants.DOCUMENT_RETRY_INITIATED,
            statusCode: StatusCodes.ACCEPTED,
          }),
        }),
      );
    });

    test("should invoke documentService.retryDocument with fileKey from req.query", async () => {
      const mockResult = {
        jobId: "job-456",
        fileKey: "doc-query-key.pdf",
        status: "RUNNING",
        resumeStage: DOCUMENT_STAGES.FIELD_EXTRACTION,
        progress: 56,
        streamUrl: "/sse/files/doc-query-key.pdf/stream",
      };
      documentService.retryDocument.mockResolvedValueOnce(mockResult);

      const req = {
        body: {},
        query: { fileKey: "doc-query-key.pdf" },
        auth: { userId: "user-888" },
        file: null,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await retryDocument(req, res);

      expect(documentService.retryDocument).toHaveBeenCalledWith({
        fileKey: "doc-query-key.pdf",
        userId: "user-888",
        file: null,
      });
      expect(res.status).toHaveBeenCalledWith(StatusCodes.ACCEPTED);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockResult,
          status: expect.objectContaining({
            description: messageConstants.DOCUMENT_RETRY_INITIATED,
            statusCode: StatusCodes.ACCEPTED,
          }),
        }),
      );
    });
  });

  describe("3. getAdaptiveStageTimeout (REQ-09)", () => {
    test("should return base timeout for single-page documents in compute-heavy stages", () => {
      const step = {
        stage: DOCUMENT_STAGES.OCR_RUNNING,
        timeoutMs: 300000,
      };
      const ctx = { totalPages: 1 };

      const timeout = getAdaptiveStageTimeout(step, ctx);
      expect(timeout).toBe(300000);
    });

    test("should scale timeout dynamically by 30s per page beyond page 1 for OCR_RUNNING", () => {
      const step = {
        stage: DOCUMENT_STAGES.OCR_RUNNING,
        timeoutMs: 300000,
      };
      // 5 pages = 300,000 + (4 * 30,000) = 420,000 ms (7 minutes)
      const ctx = { totalPages: 5 };

      const timeout = getAdaptiveStageTimeout(step, ctx);
      expect(timeout).toBe(420000);
    });

    test("should scale timeout dynamically for FIELD_EXTRACTION and SUMMARIZING", () => {
      const extractionStep = {
        stage: DOCUMENT_STAGES.FIELD_EXTRACTION,
        timeoutMs: 180000,
      };
      const summaryStep = {
        stage: DOCUMENT_STAGES.SUMMARIZING,
        timeoutMs: 180000,
      };
      // 10 pages = 180,000 + (9 * 30,000) = 450,000 ms
      const ctx = { checkpointData: { pageCount: 10 } };

      expect(getAdaptiveStageTimeout(extractionStep, ctx)).toBe(450000);
      expect(getAdaptiveStageTimeout(summaryStep, ctx)).toBe(450000);
    });

    test("should return base timeout without page-scaling for non-compute-heavy stages", () => {
      const validatingStep = {
        stage: DOCUMENT_STAGES.VALIDATING,
        timeoutMs: 120000,
      };
      const uploadingStep = {
        stage: DOCUMENT_STAGES.UPLOADING,
        timeoutMs: 120000,
      };
      const embeddingStep = {
        stage: DOCUMENT_STAGES.EMBEDDING,
        timeoutMs: 120000,
      };
      const ctx = { totalPages: 20 };

      expect(getAdaptiveStageTimeout(validatingStep, ctx)).toBe(120000);
      expect(getAdaptiveStageTimeout(uploadingStep, ctx)).toBe(120000);
      expect(getAdaptiveStageTimeout(embeddingStep, ctx)).toBe(120000);
    });
  });

  describe("4. Dead Code & Empty Stub Elimination (REQ-08)", () => {
    test("STAGES_PIPELINE does not contain empty stubs (PARSING, ANALYZING, CHUNKING)", () => {
      const pipelineStageNames = STAGES_PIPELINE.map((s) => s.stage);

      expect(pipelineStageNames).not.toContain(DOCUMENT_STAGES.PARSING);
      expect(pipelineStageNames).not.toContain(DOCUMENT_STAGES.ANALYZING);
      expect(pipelineStageNames).not.toContain(DOCUMENT_STAGES.CHUNKING);

      // Verify active operational stages exist in proper sequence
      expect(pipelineStageNames).toEqual([
        DOCUMENT_STAGES.VALIDATING,
        DOCUMENT_STAGES.UPLOADING,
        DOCUMENT_STAGES.OCR_RUNNING,
        DOCUMENT_STAGES.FIELD_EXTRACTION,
        DOCUMENT_STAGES.SUMMARIZING,
        DOCUMENT_STAGES.GRAPH_EXTRACTION,
        DOCUMENT_STAGES.PERSISTING,
        DOCUMENT_STAGES.EMBEDDING,
      ]);
    });

    test("DOCUMENT_STAGES constant preserves stage names for backwards compatibility", () => {
      expect(DOCUMENT_STAGES.PARSING).toBe("PARSING");
      expect(DOCUMENT_STAGES.ANALYZING).toBe("ANALYZING");
      expect(DOCUMENT_STAGES.CHUNKING).toBe("CHUNKING");
    });
  });
});
