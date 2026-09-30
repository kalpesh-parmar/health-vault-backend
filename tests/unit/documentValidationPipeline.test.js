const fs = require("fs");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const {
  validatePreUploadDocument,
  validationCache,
} = require("../../src/services/documentPreValidation.service");
const { MedGemmaQueue, medgemmaQueue } = require("../../src/services/queue/medgemmaQueue.service");
const documentController = require("../../src/controllers/document.controller");

// Mock pdf-parse and sharp so structural syntax checks pass in unit test environment
jest.mock("pdf-parse", () =>
  jest.fn(async () => ({
    text: "dummy pdf text",
    numpages: 1,
  }))
);

jest.mock("sharp", () =>
  jest.fn(() => ({
    metadata: async () => ({ width: 800, height: 600, format: "jpeg" }),
    resize: () => ({
      jpeg: () => ({
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      }),
    }),
  }))
);

describe("Document Validation Pipeline", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validationCache.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    validationCache.clear();
  });

  describe("1. Cheap Pre-Validation (before LLM)", () => {
    it("rejects invalid file extension immediately without invoking AI service", async () => {
      const validateSpy = jest.spyOn(aiServiceClient, "validateMedicalDocument");

      const file = {
        originalname: "malicious.exe",
        size: 2048,
        buffer: Buffer.from("dummy-content"),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe("UNSUPPORTED_TYPE");
      expect(result.title).toBe("Unsupported file type");
      expect(validateSpy).not.toHaveBeenCalled();
    });

    it("rejects corrupted magic bytes immediately without invoking AI service", async () => {
      const validateSpy = jest.spyOn(aiServiceClient, "validateMedicalDocument");

      const file = {
        originalname: "fake.pdf",
        size: 1024,
        buffer: Buffer.from("NOT_A_REAL_PDF_HEADER_12345"),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe("CORRUPTED_FILE");
      expect(validateSpy).not.toHaveBeenCalled();
    });
  });

  describe("2. Medical Document Classification", () => {
    it("identifies non-medical document with clear error code and explanation", async () => {
      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
        isMedical: false,
        confidence: 0.99,
        documentType: null,
        reason: "This document is a supermarket grocery receipt, not a medical record.",
      });

      const file = {
        originalname: "receipt.jpg",
        size: 5000,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe("NON_MEDICAL");
      expect(result.title).toBe("Not a medical document");
      expect(result.message).toContain("supermarket grocery receipt");
      expect(result.documentType).toBeNull();
    });

    it("identifies valid medical document and maps document type", async () => {
      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
        isMedical: true,
        confidence: 0.95,
        documentType: "PRESCERIPTION",
        reason: "Valid doctor prescription slip",
      });

      const file = {
        originalname: "doctor_rx.jpg",
        size: 6000,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xaa, 0xbb, 0xcc]),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(true);
      expect(result.documentType).toBe("PRESCERIPTION");
      expect(result.code).toBeNull();
    });
  });

  describe("3. Model Timeout and Error Handling", () => {
    it("handles model timeout with MODEL_TIMEOUT code and retryable message", async () => {
      const timeoutError = new Error("timeout of 30000ms exceeded");
      timeoutError.code = "ECONNABORTED";
      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockRejectedValueOnce(timeoutError);

      const file = {
        originalname: "large_scan.pdf",
        size: 20000,
        buffer: Buffer.from("%PDF-1.4 sample content for timeout test"),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe("MODEL_TIMEOUT");
      expect(result.title).toBe("Validation Timeout");
      expect(result.message).toContain("timed out");
    });

    it("handles model unavailability with MODEL_UNAVAILABLE code", async () => {
      const unavailableErr = new Error("AI service request failed (503): Service Unavailable");
      unavailableErr.statusCode = 503;
      unavailableErr.errorCode = "MEDGEMMA_UNAVAILABLE";
      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockRejectedValueOnce(unavailableErr);

      const file = {
        originalname: "report.pdf",
        size: 15000,
        buffer: Buffer.from("%PDF-1.4 sample content for unavailable test"),
      };

      const result = await validatePreUploadDocument(file, { failOpen: false });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe("MODEL_UNAVAILABLE");
      expect(result.title).toBe("Model Unavailable");
      expect(result.message).toContain("currently unavailable");
    });
  });

  describe("4. SHA-256 Result Cache", () => {
    it("skips LLM call on second identical file and returns cacheHit = true", async () => {
      const validateSpy = jest
        .spyOn(aiServiceClient, "validateMedicalDocument")
        .mockResolvedValue({
          isMedical: true,
          confidence: 0.96,
          documentType: "LAB_REPORT",
          reason: "Complete Blood Count Lab Report",
        });

      const file1 = {
        originalname: "cbc-report.pdf",
        size: 12000,
        buffer: Buffer.from("%PDF-1.4 identical bytes for sha256 cache verification"),
      };

      const file2 = {
        originalname: "cbc-report-copy.pdf",
        size: 12000,
        buffer: Buffer.from("%PDF-1.4 identical bytes for sha256 cache verification"),
      };

      // First run: calls AI service
      const res1 = await validatePreUploadDocument(file1, { failOpen: false });
      expect(res1.isValid).toBe(true);
      expect(res1.cacheHit).toBe(false);
      expect(validateSpy).toHaveBeenCalledTimes(1);

      // Second run: hits cache
      const res2 = await validatePreUploadDocument(file2, { failOpen: false });
      expect(res2.isValid).toBe(true);
      expect(res2.cacheHit).toBe(true);
      expect(res2.documentType).toBe("LAB_REPORT");
      // AI service was NOT called a second time
      expect(validateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("5. Server-Side Concurrency Queue", () => {
    it("limits concurrent executions to configured limit", async () => {
      const queue = new MedGemmaQueue(2);
      let running = 0;
      let maxRunning = 0;

      const makeTask = (delayMs) => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        running--;
        return "done";
      };

      const promises = [
        queue.run(makeTask(30)),
        queue.run(makeTask(30)),
        queue.run(makeTask(30)),
        queue.run(makeTask(30)),
      ];

      const results = await Promise.all(promises);
      expect(results).toEqual(["done", "done", "done", "done"]);
      expect(maxRunning).toBe(2);
    });
  });

  describe("6. Controller Endpoint Contract & Per-File Isolation", () => {
    it("returns stable contract with clientFileId for single file", async () => {
      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
        isMedical: true,
        documentType: "PRESCERIPTION",
        reason: "Valid prescription",
      });

      const req = {
        file: {
          originalname: "my_rx.jpg",
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22]),
          size: 1000,
        },
        body: {
          clientFileId: "client-uuid-999",
        },
      };

      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json: jest.fn(function (body) {
          this.body = body;
          return body;
        }),
      };

      await documentController.validateDocuments(req, res);

      expect(res.json).toHaveBeenCalled();
      const responseData = res.body.data;
      expect(responseData.clientFileId).toBe("client-uuid-999");
      expect(responseData.fileName).toBe("my_rx.jpg");
      expect(responseData.isValid).toBe(true);
      expect(responseData.documentType).toBe("PRESCERIPTION");
      expect(Array.isArray(responseData.results)).toBe(true);
      expect(responseData.results[0].clientFileId).toBe("client-uuid-999");
    });

    it("isolates errors per file across a multi-file batch", async () => {
      jest
        .spyOn(aiServiceClient, "validateMedicalDocument")
        .mockResolvedValueOnce({
          isMedical: true,
          documentType: "LAB_REPORT",
        })
        .mockResolvedValueOnce({
          isMedical: false,
          reason: "Utility bill",
        });

      const req = {
        files: [
          {
            originalname: "medical-lab.pdf",
            buffer: Buffer.from("%PDF-1.4 file 1 lab report"),
            size: 1000,
          },
          {
            originalname: "utility-bill.jpg",
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0x33, 0x44]),
            size: 1000,
          },
        ],
        body: {
          clientFileIds: ["f1", "f2"],
        },
      };

      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json: jest.fn(function (body) {
          this.body = body;
          return body;
        }),
      };

      await documentController.validateDocuments(req, res);

      const results = res.body.data.results;
      expect(results).toHaveLength(2);
      expect(results[0].clientFileId).toBe("f1");
      expect(results[0].isValid).toBe(true);
      expect(results[0].documentType).toBe("LAB_REPORT");

      expect(results[1].clientFileId).toBe("f2");
      expect(results[1].isValid).toBe(false);
      expect(results[1].code).toBe("NON_MEDICAL");
    });

    it("cleans up disk temp files in finally block", async () => {
      const unlinkSpy = jest.spyOn(fs, "unlink").mockImplementation((p, cb) => cb && cb());
      jest.spyOn(fs, "existsSync").mockReturnValue(true);

      jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
        isMedical: true,
      });

      const req = {
        files: [
          {
            originalname: "test.pdf",
            path: "/tmp/fake-temp-path.pdf",
            buffer: Buffer.from("%PDF-1.4 test cleanup"),
            size: 500,
          },
        ],
      };

      const res = {
        status: () => res,
        json: jest.fn(),
      };

      await documentController.validateDocuments(req, res);

      expect(unlinkSpy).toHaveBeenCalledWith("/tmp/fake-temp-path.pdf", expect.any(Function));
    });
  });
});
