const { runExtraction, runWithConcurrency } = require("../../src/services/document.service");
const objectStorageService = require("../../src/services/objectStorage.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { ocrOrchestrator, ocrService } = require("../../src/services/ai");
const documentPersistenceService = require("../../src/services/documentPersistence.service");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");
const { StageType } = require("../../src/enums/stageStatus");

jest.mock("../../src/services/objectStorage.service");
jest.mock("../../src/clients/aiServiceClient");
jest.mock("../../src/services/ai", () => ({
  ocrOrchestrator: {
    runFromStorage: jest.fn(),
  },
  ocrService: {
    normalizeExtraction: jest.fn(),
    generateSummary: jest.fn(),
  },
  embeddingService: {
    embedAndPersist: jest.fn(),
  },
}));
jest.mock("../../src/services/documentPersistence.service");
jest.mock("../../src/services/ai/clients/aiClient.service", () => ({
  extractGraphs: jest.fn().mockResolvedValue([]),
}));

describe("runExtraction Unit Tests", () => {
  let dummyFile;
  let dummyRecord;
  let mockEmitter;

  beforeEach(() => {
    jest.clearAllMocks();

    dummyFile = {
      originalname: "blood_test_report.pdf",
      mimetype: "application/pdf",
      size: 1024 * 50,
      buffer: Buffer.from("dummy pdf data"),
    };

    dummyRecord = {
      fileKey: "doc-key-123",
      batchId: "batch-456",
      patientId: "patient-789",
      uploadedBy: "patient-789",
      fileName: "blood_test_report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024 * 50,
      status: StageType.QUEUED,
    };

    mockEmitter = {
      stage: jest.fn(),
      error: jest.fn(),
      done: jest.fn(),
    };

    objectStorageService.uploadFile.mockResolvedValue({
      fileKey: "patient-documents/patient-789/uuid-blood_test_report.pdf",
      s3Bucket: "health-vault-dev-bucket",
    });

    aiServiceClient.validateMedicalDocument.mockResolvedValue({
      isMedical: true,
      confidence: 0.95,
      documentType: "LAB_REPORT",
      reason: "Blood test report with lab values",
      method: "medgemma",
      model: "medgemma:4b",
      metrics: { processing_seconds: 0.5, pages_used: 1, used_ollama: true },
    });

    ocrOrchestrator.runFromStorage.mockResolvedValue({
      fullText: "Patient Name: John Doe\nHemoglobin: 14.2 g/dL",
      pageCount: 1,
    });

    ocrService.normalizeExtraction.mockResolvedValue({
      rawOcrData: { fullText: "Patient Name: John Doe\nHemoglobin: 14.2 g/dL" },
      structured: { summary: "Normal blood test report", reportType: "LAB_REPORT" },
    });

    documentPersistenceService.addDocument.mockResolvedValue({
      document: { id: "doc-uuid-999", fileName: "blood_test_report.pdf" },
      embeddings: { embeddings: 1 },
    });
  });

  test("Valid medical document completes full extraction pipeline successfully", async () => {
    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).not.toBeNull();
    expect(result.status).toBe(StageType.COMPLETED);
    expect(objectStorageService.uploadFile).toHaveBeenCalledWith(
      dummyFile,
      "documents",
      "patient-789",
    );
    expect(aiServiceClient.validateMedicalDocument).toHaveBeenCalledWith({
      file: dummyFile.buffer,
      fileName: dummyFile.originalname,
      mimeType: dummyFile.mimetype,
    });
    expect(ocrOrchestrator.runFromStorage).toHaveBeenCalled();
    expect(mockEmitter.done).toHaveBeenCalledTimes(1);
    expect(mockEmitter.error).not.toHaveBeenCalled();
  });

  test("Non-medical document fails validation and stops without running OCR", async () => {
    aiServiceClient.validateMedicalDocument.mockResolvedValue({
      isMedical: false,
      confidence: 0.2,
      reason: "Document appears to be a electricity bill",
      method: "medgemma",
      model: "medgemma:4b",
      metrics: { processing_seconds: 0.4, pages_used: 1, used_ollama: true },
    });

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.VALIDATING,
      "Document appears to be a electricity bill",
    );
    expect(ocrOrchestrator.runFromStorage).not.toHaveBeenCalled();
    expect(mockEmitter.done).not.toHaveBeenCalled();
  });

  test("Invalid MIME type fails early during format validation stage", async () => {
    dummyRecord.mimeType = "application/x-executable";

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe(StageType.FAILED);
    expect(dummyRecord.errorCode).toBe("INVALID_DOCUMENT_TYPE");
    expect(mockEmitter.error).toHaveBeenCalledWith(DOCUMENT_STAGES.VALIDATING, expect.any(String));
    expect(objectStorageService.uploadFile).not.toHaveBeenCalled();
    expect(aiServiceClient.validateMedicalDocument).not.toHaveBeenCalled();
  });

  test("Validation API network failure/timeout is caught cleanly", async () => {
    aiServiceClient.validateMedicalDocument.mockRejectedValue(
      new Error("AI service request failed (503): MedGemma unavailable"),
    );

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe(StageType.FAILED);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.VALIDATING,
      "AI service request failed (503): MedGemma unavailable",
    );
    expect(mockEmitter.done).not.toHaveBeenCalled();
  });

  test("OCR engine failure is caught cleanly with single error emission", async () => {
    ocrOrchestrator.runFromStorage.mockRejectedValue(
      new Error("OCR engine crash: unreadable stream"),
    );

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe(StageType.FAILED);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.VALIDATING,
      "OCR engine crash: unreadable stream",
    );
    expect(mockEmitter.done).not.toHaveBeenCalled();
  });

  test("Single completion event (done or error) is emitted per document without duplicate done calls", async () => {
    await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(mockEmitter.done).toHaveBeenCalledTimes(1);
    expect(mockEmitter.error).not.toHaveBeenCalled();
  });

  test("Concurrency runner processes multiple document jobs boundedly", async () => {
    const jobs = [
      { file: dummyFile, record: { ...dummyRecord, fileKey: "k1" }, emitter: mockEmitter },
      { file: dummyFile, record: { ...dummyRecord, fileKey: "k2" }, emitter: mockEmitter },
    ];

    await runWithConcurrency(jobs, 2);

    expect(objectStorageService.uploadFile).toHaveBeenCalledTimes(2);
    expect(aiServiceClient.validateMedicalDocument).toHaveBeenCalledTimes(2);
  });
});
