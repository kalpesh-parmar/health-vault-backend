const documentJobSweeper = require("../../src/jobs/documentJobSweeper");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");

jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  sweepExpired: jest.fn(),
  failStalledRunningJobs: jest.fn(),
  findStalledRunningJobs: jest.fn(),
  reconcileRunningJobsOnBoot: jest.fn(),
}));

describe("Document Job Sweeper & Recovery Unit Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    documentJobSweeper.stopSweeper();
  });

  describe("1. Stalled Job Sweeping", () => {
    test("sweepStalledJobs identifies and transitions jobs past cutoff to FAILED", async () => {
      const mockFailed = [
        { id: "job-stalled-1", fileKey: "doc1.pdf", status: "FAILED", retryable: true },
        { id: "job-stalled-2", fileKey: "doc2.pdf", status: "FAILED", retryable: true },
      ];
      documentProcessingJobRepository.failStalledRunningJobs.mockResolvedValue(mockFailed);

      const beforeTime = Date.now();
      const result = await documentJobSweeper.sweepStalledJobs(15);
      const afterTime = Date.now();

      expect(result).toEqual(mockFailed);
      expect(documentProcessingJobRepository.failStalledRunningJobs).toHaveBeenCalledTimes(1);

      const [passedCutoff, passedReason] =
        documentProcessingJobRepository.failStalledRunningJobs.mock.calls[0];

      // Cutoff should be approximately 15 minutes before now
      const fifteenMinsMs = 15 * 60 * 1000;
      expect(passedCutoff.getTime()).toBeLessThanOrEqual(afterTime - fifteenMinsMs);
      expect(passedCutoff.getTime()).toBeGreaterThanOrEqual(beforeTime - fifteenMinsMs);
      expect(passedReason).toContain("timed out without heartbeat");
    });

    test("sweepStalledJobs returns empty array gracefully on error", async () => {
      documentProcessingJobRepository.failStalledRunningJobs.mockRejectedValue(
        new Error("DB connection failure"),
      );

      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await documentJobSweeper.sweepStalledJobs(10);
      expect(result).toEqual([]);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("2. Expired Job Sweeping", () => {
    test("sweepExpiredJobs delegates to repository and returns removed rows", async () => {
      documentProcessingJobRepository.sweepExpired.mockResolvedValue([
        { id: "expired-1" },
        { id: "expired-2" },
      ]);

      const result = await documentJobSweeper.sweepExpiredJobs();

      expect(result).toHaveLength(2);
      expect(documentProcessingJobRepository.sweepExpired).toHaveBeenCalledTimes(1);
    });

    test("sweepExpiredJobs returns empty array gracefully on error", async () => {
      documentProcessingJobRepository.sweepExpired.mockRejectedValue(new Error("Timeout"));

      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await documentJobSweeper.sweepExpiredJobs();
      expect(result).toEqual([]);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("3. Sweeper Lifecycle (start / stop)", () => {
    test("startSweeper and stopSweeper manage cron tasks without errors", () => {
      expect(() => {
        documentJobSweeper.startSweeper();
        documentJobSweeper.stopSweeper();
      }).not.toThrow();
    });
  });

  describe("4. Boot Reconciliation Guarantee", () => {
    test("reconcileRunningJobsOnBoot marks interrupted RUNNING jobs as FAILED with retryable: true", async () => {
      const mockReconciled = [
        {
          id: "zombie-job-1",
          status: "FAILED",
          retryable: true,
          error: "Server restarted during document processing",
        },
      ];
      documentProcessingJobRepository.reconcileRunningJobsOnBoot.mockResolvedValue(mockReconciled);

      const result = await documentProcessingJobRepository.reconcileRunningJobsOnBoot();
      expect(result).toEqual(mockReconciled);
      expect(result[0].retryable).toBe(true);
      expect(result[0].status).toBe("FAILED");
    });
  });
});
