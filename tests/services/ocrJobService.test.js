const documentOcrJobService = require("../../src/services/documentOcrJob.service");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const {
  ConflictException,
  InvalidRequestException,
  NotFoundException,
} = require("../../src/exceptions/appError");

jest.mock("../../src/configs/db", () => ({
  db: {
    transaction: jest.fn().mockImplementation(async (cb) => cb({})),
  },
}));

describe("Phase 3 — OCR Job Control Service Tests", () => {
  const mockUserId = "11111111-1111-1111-1111-111111111111";
  const mockJobId = "22222222-2222-2222-2222-222222222222";
  const mockFileKey = "documents/11111111-1111-1111-1111-111111111111/uuid-report.pdf";

  const queuedJob = {
    id: mockJobId,
    fileKey: mockFileKey,
    userId: mockUserId,
    status: "QUEUED",
    stage: "OCR_QUEUED",
    percentage: 0,
    metadata: { mimeType: "application/pdf", originalName: "report.pdf" },
  };

  const runningJob = {
    ...queuedJob,
    status: "RUNNING",
    stage: "EXTRACTING",
    percentage: 40,
  };

  const completedJob = {
    ...queuedJob,
    status: "COMPLETED",
    stage: "COMPLETED",
    percentage: 100,
    extractedStructuredData: {
      medications: [{ name: "Amoxicillin" }],
      summaryEnglish: "Patient is prescribed Amoxicillin.",
      summaryInPreferredLanguage: "Patient is prescribed Amoxicillin.",
    },
    graphs: [{ title: "Blood Pressure Trend" }],
  };

  const failedJob = {
    ...queuedJob,
    status: "FAILED",
    stage: "FAILED",
    error: "Document corruption detected",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("startJobById", () => {
    it("should atomically claim a QUEUED job, trigger pipeline via setImmediate, and return claimed job", async () => {
      jest.spyOn(documentProcessingJobRepository, "claimQueuedJob").mockResolvedValue(runningJob);
      jest.spyOn(documentOcrJobService, "_runPipeline").mockResolvedValue();

      const result = await documentOcrJobService.startJobById(mockJobId, mockUserId);

      expect(documentProcessingJobRepository.claimQueuedJob).toHaveBeenCalledWith(
        mockJobId,
        mockUserId,
      );
      expect(result.status).toBe("RUNNING");
    });

    it("should throw InvalidRequestException if job is already RUNNING or COMPLETED", async () => {
      jest.spyOn(documentProcessingJobRepository, "claimQueuedJob").mockResolvedValue(null);
      jest
        .spyOn(documentProcessingJobRepository, "findByIdAndUserId")
        .mockResolvedValue(runningJob);

      await expect(documentOcrJobService.startJobById(mockJobId, mockUserId)).rejects.toThrow(
        InvalidRequestException,
      );
    });

    it("should throw NotFoundException if job does not exist", async () => {
      jest.spyOn(documentProcessingJobRepository, "claimQueuedJob").mockResolvedValue(null);
      jest.spyOn(documentProcessingJobRepository, "findByIdAndUserId").mockResolvedValue(null);

      await expect(documentOcrJobService.startJobById(mockJobId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getJobById", () => {
    it("should return job status when job exists and user matches", async () => {
      jest
        .spyOn(documentProcessingJobRepository, "findByIdAndUserId")
        .mockResolvedValue(runningJob);

      const result = await documentOcrJobService.getJobById(mockJobId, mockUserId);
      expect(result.id).toBe(mockJobId);
      expect(result.status).toBe("RUNNING");
    });

    it("should throw NotFoundException when job does not exist or user mismatch", async () => {
      jest.spyOn(documentProcessingJobRepository, "findByIdAndUserId").mockResolvedValue(null);

      await expect(documentOcrJobService.getJobById(mockJobId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getJobResult", () => {
    it("should throw ConflictException (409) if job status is QUEUED or RUNNING", async () => {
      jest
        .spyOn(documentProcessingJobRepository, "findByIdAndUserId")
        .mockResolvedValue(runningJob);

      await expect(documentOcrJobService.getJobResult(mockJobId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it("should return extracted data, summaries, and graphs when status is COMPLETED", async () => {
      jest
        .spyOn(documentProcessingJobRepository, "findByIdAndUserId")
        .mockResolvedValue(completedJob);

      const result = await documentOcrJobService.getJobResult(mockJobId, mockUserId);

      expect(result.status).toBe("COMPLETED");
      expect(result.extractedStructuredData.medications).toHaveLength(1);
      expect(result.summaries.summaryEnglish).toBe("Patient is prescribed Amoxicillin.");
      expect(result.graphs).toHaveLength(1);
    });

    it("should throw InvalidRequestException if job status is FAILED", async () => {
      jest.spyOn(documentProcessingJobRepository, "findByIdAndUserId").mockResolvedValue(failedJob);

      await expect(documentOcrJobService.getJobResult(mockJobId, mockUserId)).rejects.toThrow(
        InvalidRequestException,
      );
    });
  });
});
