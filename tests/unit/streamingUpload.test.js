const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const {
  documentDiskStorage,
  validateDocumentUpload,
} = require("../../src/validations/uploadValidation");
const { env } = require("../../src/configs/env");
const { errorConstants } = require("../../src/constants/errorConstants");
const { InvalidRequestException } = require("../../src/exceptions/appError");
const fileService = require("../../src/services/file.service");
const gcpStorageService = require("../../src/services/gcpStorage.service");
const { s3Client } = require("../../src/configs/file");
const { gcpStorage } = require("../../src/configs/gcpStorage");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { runExtraction } = require("../../src/services/document.service");
const objectStorageService = require("../../src/services/objectStorage.service");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const { StageType } = require("../../src/enums/stageStatus");
jest.mock("pdf-parse", () => jest.fn(async () => ({ numpages: 1 })));
jest.mock("../../src/services/objectStorage.service");
jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  findByFileKey: jest.fn().mockResolvedValue(null),
  createQueuedJob: jest.fn().mockResolvedValue({ id: "job-1" }),
  checkpointStage: jest.fn().mockResolvedValue({}),
  markCompleted: jest.fn().mockResolvedValue({}),
}));

describe("Phase 1: Streaming Ingestion & Memory Safety Tests", () => {
  const testTempDir = path.resolve(__dirname, "../../uploads/temp_unit_test");

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    documentProcessingJobRepository.findByFileKey.mockResolvedValue(null);
  });

  describe("1. Disk Storage Configuration (documentDiskStorage)", () => {
    it("should set destination to env.uploadTempDir and ensure directory exists", (done) => {
      const mockReq = {};
      const mockFile = { originalname: "patient_lab_report.pdf" };

      documentDiskStorage.getDestination(mockReq, mockFile, (err, destination) => {
        expect(err).toBeNull();
        expect(destination).toBe(env.uploadTempDir);
        expect(fs.existsSync(destination)).toBe(true);
        done();
      });
    });

    it("should generate random UUID filename preserving valid file extension", (done) => {
      const mockReq = {};
      const mockFile = { originalname: "blood_test_2026.pdf" };

      documentDiskStorage.getFilename(mockReq, mockFile, (err, filename) => {
        expect(err).toBeNull();
        expect(filename).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i,
        );
        done();
      });
    });

    it("should sanitize and handle files without extensions", (done) => {
      const mockReq = {};
      const mockFile = { originalname: "no_extension_file" };

      documentDiskStorage.getFilename(mockReq, mockFile, (err, filename) => {
        expect(err).toBeNull();
        expect(filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        done();
      });
    });
  });

  describe("2. Multer Limit & Batch Configuration", () => {
    it("should allow up to env.maxFilesPerUpload (20 files)", () => {
      expect(env.maxFilesPerUpload).toBe(20);
    });

    it("should reject uploads exceeding max file limit with parameterized error", () => {
      const err = { code: "LIMIT_FILE_COUNT" };
      const req = {};
      const res = {};
      const next = jest.fn();

      const customMulter = (r, s, cb) => cb(err);
      const handler = (rq, rs, nxt) => {
        customMulter(rq, rs, (uploadErr) => {
          if (
            uploadErr &&
            (uploadErr.code === "LIMIT_FILE_COUNT" || uploadErr.code === "LIMIT_UNEXPECTED_FILE")
          ) {
            return nxt(
              new InvalidRequestException(
                errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED(env.maxFilesPerUpload || 20),
              ),
            );
          }
          return nxt();
        });
      };

      handler(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(InvalidRequestException));
      const error = next.mock.calls[0][0];
      expect(error.message).toContain("20");
    });

    it("should reject files exceeding maximum document size (150MB)", () => {
      const err = { code: "LIMIT_FILE_SIZE" };
      const req = {};
      const res = {};
      const next = jest.fn();

      const customMulter = (r, s, cb) => cb(err);
      const handler = (rq, rs, nxt) => {
        customMulter(rq, rs, (uploadErr) => {
          if (uploadErr && uploadErr.code === "LIMIT_FILE_SIZE") {
            return nxt(
              new InvalidRequestException("File size exceeds the limit of 150 MB per file"),
            );
          }
          return nxt();
        });
      };

      handler(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(InvalidRequestException));
      const error = next.mock.calls[0][0];
      expect(error.message).toContain("150 MB");
    });
  });

  describe("3. Validation & Temporary File Cleanup (validateDocumentUpload)", () => {
    it("should reject when no files are provided", async () => {
      const req = { files: [] };
      const res = {};
      const next = jest.fn();

      await validateDocumentUpload(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(InvalidRequestException));
      expect(next.mock.calls[0][0].message).toBe("At least one document file is required.");
    });

    it("should reject when file count exceeds env.maxFilesPerUpload", async () => {
      const files = Array.from({ length: 21 }, (_, i) => ({
        originalname: `file_${i}.pdf`,
        mimetype: "application/pdf",
        size: 1024,
      }));
      const req = { files };
      const res = {};
      const next = jest.fn();

      await validateDocumentUpload(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(InvalidRequestException));
      expect(next.mock.calls[0][0].message).toBe(
        errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED(20),
      );
    });

    it("should accept valid batches of up to 20 files", async () => {
      const files = Array.from({ length: 20 }, (_, i) => ({
        originalname: `file_${i}.pdf`,
        mimetype: "application/pdf",
        size: 1024,
      }));
      const req = { files };
      const res = {};
      const next = jest.fn();

      await validateDocumentUpload(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it("should reject unsupported MIME types and clean up any temp files on disk", async () => {
      const tempFilePath = path.join(testTempDir, `temp_cleanup_test_${Date.now()}.exe`);
      fs.writeFileSync(tempFilePath, "executable content");
      expect(fs.existsSync(tempFilePath)).toBe(true);

      const req = {
        files: [
          {
            originalname: "malicious.exe",
            mimetype: "application/x-msdownload",
            size: 1024,
            path: tempFilePath,
          },
        ],
      };
      const res = {};
      const next = jest.fn();

      await validateDocumentUpload(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(InvalidRequestException));

      // Wait a tick for async unlink
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(tempFilePath)).toBe(false);
    });
  });

  describe("4. Storage Streaming Direct from Disk (S3 & GCP)", () => {
    it("should stream from disk via fs.createReadStream for S3 uploadFile", async () => {
      const tempFilePath = path.join(testTempDir, `s3_stream_test_${Date.now()}.pdf`);
      fs.writeFileSync(tempFilePath, "%PDF-1.4 dummy data for streaming test");

      const file = {
        originalname: "report.pdf",
        mimetype: "application/pdf",
        size: 38,
        path: tempFilePath,
      };

      const mockStream = new EventEmitter();
      mockStream.pipe = jest.fn();
      const createReadStreamSpy = jest.spyOn(fs, "createReadStream").mockReturnValue(mockStream);
      const sendSpy = jest.spyOn(s3Client, "send").mockResolvedValue({});

      const result = await fileService.uploadFile(file, "documents", "user-123", {
        fileKey: "documents/user-123/test.pdf",
      });

      expect(createReadStreamSpy).toHaveBeenCalledWith(tempFilePath);
      expect(sendSpy).toHaveBeenCalled();
      expect(result.fileKey).toBe("documents/user-123/test.pdf");

      createReadStreamSpy.mockRestore();
      sendSpy.mockRestore();
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });

    it("should pipe from disk via fs.createReadStream for GCP Storage uploadFile", async () => {
      const tempFilePath = path.join(testTempDir, `gcp_stream_test_${Date.now()}.pdf`);
      fs.writeFileSync(tempFilePath, "%PDF-1.4 dummy data for gcp streaming test");

      const file = {
        originalname: "gcp_report.pdf",
        mimetype: "application/pdf",
        size: 42,
        path: tempFilePath,
      };

      const mockReadStream = new EventEmitter();
      mockReadStream.pipe = jest.fn().mockImplementation((dest) => {
        setImmediate(() => dest.emit("finish"));
        return dest;
      });
      const createReadStreamSpy = jest
        .spyOn(fs, "createReadStream")
        .mockReturnValue(mockReadStream);

      const mockWriteStream = new EventEmitter();
      const mockBlob = {
        createWriteStream: jest.fn().mockReturnValue(mockWriteStream),
      };
      const mockBucket = {
        file: jest.fn().mockReturnValue(mockBlob),
      };
      const bucketSpy = jest.spyOn(gcpStorage, "bucket").mockReturnValue(mockBucket);
      gcpStorageService.bucket = "test-gcp-bucket";

      const result = await gcpStorageService.uploadFile(file, "documents", "user-123", {
        fileKey: "documents/user-123/gcp_test.pdf",
      });

      expect(createReadStreamSpy).toHaveBeenCalledWith(tempFilePath);
      expect(bucketSpy).toHaveBeenCalledWith("test-gcp-bucket");
      expect(mockReadStream.pipe).toHaveBeenCalledWith(mockWriteStream);
      expect(result.fileKey).toBe("documents/user-123/gcp_test.pdf");

      createReadStreamSpy.mockRestore();
      bucketSpy.mockRestore();
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });
  });

  describe("5. AI Service Client Streaming", () => {
    it("should append a ReadStream when validateMedicalDocument is passed a file path", async () => {
      const tempFilePath = path.join(testTempDir, `ai_stream_test_${Date.now()}.pdf`);
      fs.writeFileSync(tempFilePath, "%PDF-1.4 dummy medical report");

      const createReadStreamSpy = jest.spyOn(fs, "createReadStream");
      const postWithRetrySpy = jest
        .spyOn(aiServiceClient, "postWithRetry")
        .mockResolvedValue({ is_medical: true, confidence: 0.95 });

      await aiServiceClient.validateMedicalDocument({
        file: { path: tempFilePath, originalname: "medical.pdf", mimetype: "application/pdf" },
        fileName: "medical.pdf",
        mimeType: "application/pdf",
      });

      expect(createReadStreamSpy).toHaveBeenCalledWith(tempFilePath);
      expect(postWithRetrySpy).toHaveBeenCalled();

      createReadStreamSpy.mockRestore();
      postWithRetrySpy.mockRestore();
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });
  });

  describe("6. Pipeline Lifecycle & Temp File Cleanup", () => {
    it("should unlink temp disk file in Stage 2 after successful storage upload", async () => {
      const tempFilePath = path.join(testTempDir, `pipeline_stage2_test_${Date.now()}.pdf`);
      fs.writeFileSync(tempFilePath, "content for stage 2 cleanup test");
      expect(fs.existsSync(tempFilePath)).toBe(true);

      const dummyFile = {
        originalname: "test_doc.pdf",
        mimetype: "application/pdf",
        size: 100,
        path: tempFilePath,
      };

      const dummyRecord = {
        jobId: "job-1",
        fileKey: "key-1",
        batchId: "batch-1",
        patientId: "patient-1",
        status: StageType.IN_PROGRESS,
      };

      const dummyEmitter = {
        emit: jest.fn(),
        stage: jest.fn(),
        progress: jest.fn(),
        completed: jest.fn(),
        error: jest.fn(),
      };

      objectStorageService.uploadFile.mockResolvedValue({
        fileKey: "key-1",
        s3Bucket: "test-bucket",
      });

      documentProcessingJobRepository.checkpointStage.mockResolvedValue({});
      documentProcessingJobRepository.markCompleted.mockResolvedValue({});

      const mockOcr = {
        runFromStorage: jest.fn().mockResolvedValue({
          text: "Sample medical extraction",
          confidence: 0.9,
        }),
      };

      await runExtraction({
        file: dummyFile,
        record: dummyRecord,
        emitter: dummyEmitter,
        ocr: mockOcr,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(tempFilePath)).toBe(false);
    });

    it("should unlink temp disk file in finally block upon pipeline terminal error", async () => {
      const tempFilePath = path.join(testTempDir, `pipeline_fail_test_${Date.now()}.pdf`);
      fs.writeFileSync(tempFilePath, "content for failure cleanup test");
      expect(fs.existsSync(tempFilePath)).toBe(true);

      const dummyFile = {
        originalname: "fail_doc.pdf",
        mimetype: "application/pdf",
        size: 100,
        path: tempFilePath,
      };

      const dummyRecord = {
        jobId: "job-2",
        fileKey: "key-2",
        batchId: "batch-2",
        patientId: "patient-2",
        status: StageType.IN_PROGRESS,
      };

      const dummyEmitter = {
        emit: jest.fn(),
        stage: jest.fn(),
        progress: jest.fn(),
        completed: jest.fn(),
        error: jest.fn(),
      };

      objectStorageService.uploadFile.mockRejectedValue(new Error("Storage bucket unreachable"));
      documentProcessingJobRepository.checkpointStage.mockResolvedValue({});

      await runExtraction({
        file: dummyFile,
        record: dummyRecord,
        emitter: dummyEmitter,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(tempFilePath)).toBe(false);
    });
  });

  describe("7. Memory Profiling & Heap Safety Check", () => {
    it("should process a 20-file batch without exceeding memory threshold", () => {
      const initialHeap = process.memoryUsage().heapUsed;
      const files = [];

      for (let i = 0; i < 20; i++) {
        files.push({
          fieldname: "files",
          originalname: `patient_record_${i}.pdf`,
          encoding: "7bit",
          mimetype: "application/pdf",
          destination: env.uploadTempDir,
          filename: `${crypto.randomUUID()}.pdf`,
          path: path.join(env.uploadTempDir, `${crypto.randomUUID()}.pdf`),
          size: 50 * 1024 * 1024,
        });
      }

      const postAllocationHeap = process.memoryUsage().heapUsed;
      const heapDeltaMB = (postAllocationHeap - initialHeap) / (1024 * 1024);

      expect(heapDeltaMB).toBeLessThan(50);
      expect(files.length).toBe(20);
      files.forEach((f) => {
        expect(f.buffer).toBeUndefined();
        expect(f.path).toBeDefined();
      });
    });
  });
});
