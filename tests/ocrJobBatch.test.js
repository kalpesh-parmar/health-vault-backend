const documentOcrJobService = require("../src/services/documentOcrJob.service");
const documentProcessingJobRepository = require("../src/repositories/documentProcessingJobRepository");

jest.mock("../src/repositories/documentProcessingJobRepository");
jest.mock("../src/repositories/documentIntelligenceRepository", () => {
  return jest.fn().mockImplementation(() => ({
    getPatientContext: jest.fn().mockResolvedValue(null),
  }));
});

describe("DocumentOcrJobService - Batch Operations", () => {
  const userId = "11111111-1111-1111-1111-111111111111";
  const job1Id = "550e8400-e29b-41d4-a716-446655440000";
  const job2Id = "671e8400-e29b-41d4-a716-446655440001";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(documentOcrJobService, "_runPipeline").mockResolvedValue();
  });

  describe("startBatchJobs", () => {
    it("should throw InvalidRequestException if jobIds is not an array or empty", async () => {
      await expect(documentOcrJobService.startBatchJobs(null, userId)).rejects.toThrow();
      await expect(documentOcrJobService.startBatchJobs([], userId)).rejects.toThrow();
    });

    it("should process and return started and failed jobs summary", async () => {
      documentProcessingJobRepository.claimQueuedJob
        .mockResolvedValueOnce({
          id: job1Id,
          fileKey: "documents/doc1.pdf",
          stage: "OCR_STARTED",
          metadata: { mimeType: "application/pdf" },
        })
        .mockResolvedValueOnce(null);

      documentProcessingJobRepository.findByIdAndUserId.mockResolvedValueOnce({
        id: job2Id,
        status: "RUNNING",
      });

      const result = await documentOcrJobService.startBatchJobs([job1Id, job2Id], userId);

      expect(result.started).toHaveLength(1);
      expect(result.started[0]).toEqual({
        jobId: job1Id,
        fileKey: "documents/doc1.pdf",
        status: "OCR_STARTED",
        stage: "OCR_STARTED",
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].jobId).toBe(job2Id);
      expect(result.failed[0].status).toBe("RUNNING");
    });
  });

  describe("getBatchJobStatuses", () => {
    it("should throw InvalidRequestException if jobIds is empty", async () => {
      await expect(documentOcrJobService.getBatchJobStatuses([], userId)).rejects.toThrow();
    });

    it("should return statuses and results for found and missing jobs", async () => {
      documentProcessingJobRepository.findManyByIdsAndUserId.mockResolvedValue([
        {
          id: job1Id,
          fileKey: "documents/doc1.pdf",
          status: "COMPLETED",
          stage: "COMPLETED",
          percentage: 100,
          currentStep: "Done",
          completedSteps: 8,
          pendingSteps: 0,
          message: null,
          error: null,
          startedAt: new Date(),
          completedAt: new Date(),
          extractedStructuredData: {
            summaryEnglish: "Test summary",
            summaryInPreferredLanguage: "ટેસ્ટ સsummary",
          },
          graphs: [],
        },
      ]);

      const results = await documentOcrJobService.getBatchJobStatuses([job1Id, job2Id], userId);

      expect(results).toHaveLength(2);

      const job1Result = results.find((r) => r.jobId === job1Id);
      expect(job1Result.found).toBe(true);
      expect(job1Result.status).toBe("COMPLETED");
      expect(job1Result.summaries.summaryEnglish).toBe("Test summary");

      const job2Result = results.find((r) => r.jobId === job2Id);
      expect(job2Result.found).toBe(false);
      expect(job2Result.status).toBe("NOT_FOUND");
    });
  });
});
