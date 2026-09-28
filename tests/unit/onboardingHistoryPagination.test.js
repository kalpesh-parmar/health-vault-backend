const ocrService = require("../../src/services/ocr.service");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const { UnauthorizedException } = require("../../src/exceptions/appError");

const documentRepository = require("../../src/repositories/documentRepository");

describe("Onboarding Chat History Pagination Tests", () => {
  const mockUserId = "user-123e4567-e89b-12d3-a456-426614174000";
  const mockSessionId = "session-123e4567-e89b-12d3-a456-426614174001";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(documentProcessingJobRepository, "findUserJobDocumentNames").mockResolvedValue([]);
    jest.spyOn(documentRepository, "findAllByFilterAndSort").mockResolvedValue([]);
    jest.spyOn(documentProcessingJobRepository, "getUserJobSummary").mockResolvedValue({
      totalUploads: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should throw UnauthorizedException if userId is not provided", async () => {
    await expect(ocrService.getOnboardingHistory(null)).rejects.toThrow(UnauthorizedException);
  });

  it("should return empty messages if chatSessionId is not present in onboarding state", async () => {
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { currentStep: "ASK_LANGUAGE" },
    });
    const listMessagesSpy = jest.spyOn(chatSessionRepository, "listMessages");

    const result = await ocrService.getOnboardingHistory(mockUserId);

    expect(result.messages).toEqual([]);
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it("should fetch a single page of messages when total messages <= 100", async () => {
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { chatSessionId: mockSessionId, currentStep: "ASK_DOCUMENT_CONFIRMATION" },
    });

    const mockMessages = Array.from({ length: 45 }, (_, i) => ({
      id: `msg-${i + 1}`,
      seq: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    }));

    const listMessagesSpy = jest
      .spyOn(chatSessionRepository, "listMessages")
      .mockResolvedValueOnce({
        items: mockMessages,
        nextCursor: null,
      });

    const result = await ocrService.getOnboardingHistory(mockUserId);

    expect(listMessagesSpy).toHaveBeenCalledTimes(1);
    expect(listMessagesSpy).toHaveBeenCalledWith({
      sessionId: mockSessionId,
      userId: mockUserId,
      limit: 100,
      direction: "after",
      cursor: null,
    });
    expect(result.messages).toHaveLength(45);
    expect(result.messages[0].seq).toBe(1);
    expect(result.messages[44].seq).toBe(45);
  });

  it("should paginate and fetch all messages using nextCursor when total messages > 100 (e.g. 150 messages)", async () => {
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { chatSessionId: mockSessionId, currentStep: "ASK_DOCUMENT_CONFIRMATION" },
    });

    const page1Messages = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i + 1}`,
      seq: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    }));

    const page2Messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i + 101}`,
      seq: i + 101,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 101}`,
    }));

    const listMessagesSpy = jest
      .spyOn(chatSessionRepository, "listMessages")
      .mockResolvedValueOnce({
        items: page1Messages,
        nextCursor: "MTAw", // base64url for "100"
      })
      .mockResolvedValueOnce({
        items: page2Messages,
        nextCursor: null,
      });

    const result = await ocrService.getOnboardingHistory(mockUserId);

    expect(listMessagesSpy).toHaveBeenCalledTimes(2);
    expect(listMessagesSpy).toHaveBeenNthCalledWith(1, {
      sessionId: mockSessionId,
      userId: mockUserId,
      limit: 100,
      direction: "after",
      cursor: null,
    });
    expect(listMessagesSpy).toHaveBeenNthCalledWith(2, {
      sessionId: mockSessionId,
      userId: mockUserId,
      limit: 100,
      direction: "after",
      cursor: "MTAw",
    });

    expect(result.messages).toHaveLength(150);
    expect(result.messages[0].seq).toBe(1);
    expect(result.messages[99].seq).toBe(100);
    expect(result.messages[100].seq).toBe(101);
    expect(result.messages[149].seq).toBe(150);
  });

  it("should fetch all pages across 3 batches when total messages > 200 (e.g. 250 messages)", async () => {
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { chatSessionId: mockSessionId, currentStep: "ASK_FIRST_NAME" },
    });

    const page1Messages = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i + 1}`,
      seq: i + 1,
      role: "user",
      content: `Message ${i + 1}`,
    }));

    const page2Messages = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i + 101}`,
      seq: i + 101,
      role: "assistant",
      content: `Message ${i + 101}`,
    }));

    const page3Messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i + 201}`,
      seq: i + 201,
      role: "user",
      content: `Message ${i + 201}`,
    }));

    const listMessagesSpy = jest
      .spyOn(chatSessionRepository, "listMessages")
      .mockResolvedValueOnce({
        items: page1Messages,
        nextCursor: "MTAw",
      })
      .mockResolvedValueOnce({
        items: page2Messages,
        nextCursor: "MjAw",
      })
      .mockResolvedValueOnce({
        items: page3Messages,
        nextCursor: null,
      });

    const result = await ocrService.getOnboardingHistory(mockUserId);

    expect(listMessagesSpy).toHaveBeenCalledTimes(3);
    expect(result.messages).toHaveLength(250);
    expect(result.messages[0].seq).toBe(1);
    expect(result.messages[199].seq).toBe(200);
    expect(result.messages[200].seq).toBe(201);
    expect(result.messages[249].seq).toBe(250);
  });
});
