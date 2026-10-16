const { executeAddDocumentAction } = require("../../src/helpers/unifiedChat.helper");

describe("ADD_DOCUMENT Assistant Message Persistence & Deduplication", () => {
  let mockDocumentPersistenceService;
  let mockDocumentOcrJobService;
  let mockChatService;
  let mockChatSessionRepository;

  beforeEach(() => {
    mockDocumentPersistenceService = {
      addDocument: jest.fn().mockImplementation(async ({ fileName, s3Key }) => ({
        document: {
          id: `doc-${fileName}`,
          fileName,
          s3Key,
          ocrStatus: "COMPLETED",
          summary: "Medical summary",
        },
      })),
    };

    mockDocumentOcrJobService = {
      enqueue: jest.fn(),
      getStatus: jest.fn().mockImplementation(async ({ fileKey }) => ({
        id: `job-${fileKey}`,
        status: "COMPLETED",
        extractedStructuredData: {
          medications: [
            { name: "Paracetamol 500mg", type: "TABLET", dosage: "1", frequency: "TWICE" },
          ],
        },
      })),
    };

    mockChatService = {
      createSession: jest.fn().mockResolvedValue({ id: "session-new-123" }),
    };

    mockChatSessionRepository = {
      appendMessage: jest.fn().mockResolvedValue({ id: "msg-persisted-1" }),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("Single document upload appends exactly ONE assistant review message with complete metadata", async () => {
    const actionData = {
      s3Key: "documents/single_report.pdf",
      fileName: "single_report.pdf",
      rawOcrData: {
        extractedStructuredData: {
          medications: [
            { name: "Amoxicillin 500mg", type: "CAPSULE", dosage: "1", frequency: "THRICE" },
          ],
        },
      },
    };

    const response = await executeAddDocumentAction({
      userId: "user-test-single",
      actionData,
      sessionId: "session-test-single",
      preferredLanguage: "gujarati",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    // 1. Verify exactly one appendMessage call
    expect(mockChatSessionRepository.appendMessage).toHaveBeenCalledTimes(1);

    const callArgs = mockChatSessionRepository.appendMessage.mock.calls[0][0];

    // 2. Verify session, user, and role
    expect(callArgs.sessionId).toBe("session-test-single");
    expect(callArgs.userId).toBe("user-test-single");
    expect(callArgs.role).toBe("assistant");

    // 3. Verify exact Gujarati localized text
    expect(callArgs.content).toBe(
      "તમારા દસ્તાવેજની પ્રક્રિયા સફળતાપૂર્વક પૂર્ણ થઈ ગઈ છે. કૃપા કરીને નીચે તમારા દસ્તાવેજની સમીક્ષા કરો.",
    );

    // 4. Verify complete rich metadata is preserved
    expect(callArgs.metadata).toMatchObject({
      mode: "ACTION",
      actionType: "REVIEW_MEDICINES_LIST",
      documentSummary: expect.objectContaining({
        totalUploads: 1,
        completed: 1,
      }),
      documentsName: ["single_report.pdf"],
      documentsStatus: ["COMPLETED"],
      documentStatus: "COMPLETED",
      suggestedAction: "REVIEW_MEDICINES_LIST",
    });
    expect(callArgs.metadata.documents).toHaveLength(1);
    expect(callArgs.metadata.medicines).toHaveLength(1);
    expect(callArgs.metadata.options).toHaveLength(3); // CONFIRM, ADD, SKIP

    // 5. Verify response matches persisted structure
    expect(response.mode).toBe("ACTION");
    expect(response.reply).toBe(callArgs.content);
  });

  test("Multiple documents in a single batch append exactly ONE assistant review message for the entire batch", async () => {
    const actionData = {
      files: [
        { fileKey: "documents/batch_1.pdf", fileName: "batch_1.pdf" },
        { fileKey: "documents/batch_2.pdf", fileName: "batch_2.pdf" },
        { fileKey: "documents/batch_3.pdf", fileName: "batch_3.pdf" },
      ],
    };

    await executeAddDocumentAction({
      userId: "user-test-batch",
      actionData,
      sessionId: "session-test-batch",
      preferredLanguage: "gujarati",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    // Exactly ONE assistant review message for all 3 documents
    expect(mockChatSessionRepository.appendMessage).toHaveBeenCalledTimes(1);

    const callArgs = mockChatSessionRepository.appendMessage.mock.calls[0][0];
    expect(callArgs.content).toBe(
      "તમારા દસ્તાવેજની પ્રક્રિયા સફળતાપૂર્વક પૂર્ણ થઈ ગઈ છે. કૃપા કરીને નીચે તમારા દસ્તાવેજની સમીક્ષા કરો.",
    );
    expect(callArgs.metadata.documentsName).toEqual(["batch_1.pdf", "batch_2.pdf", "batch_3.pdf"]);
    expect(callArgs.metadata.documentsStatus).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(callArgs.metadata.documentSummary.totalUploads).toBe(3);
    expect(callArgs.metadata.documentSummary.completed).toBe(3);

    expect(callArgs.metadata.documents).toHaveLength(3);
  });

  test("Two separate, independent upload requests each append their own review message", async () => {
    // First upload request
    await executeAddDocumentAction({
      userId: "user-test-sequential",
      actionData: {
        s3Key: "documents/first_batch.pdf",
        fileName: "first_batch.pdf",
        rawOcrData: { extractedStructuredData: { medications: [] } },
      },
      sessionId: "session-test-sequential",
      preferredLanguage: "gujarati",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(mockChatSessionRepository.appendMessage).toHaveBeenCalledTimes(1);

    // Second independent upload request in the same session
    await executeAddDocumentAction({
      userId: "user-test-sequential",
      actionData: {
        s3Key: "documents/second_batch.pdf",
        fileName: "second_batch.pdf",
        rawOcrData: { extractedStructuredData: { medications: [] } },
      },
      sessionId: "session-test-sequential",
      preferredLanguage: "gujarati",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    // Total of 2 calls — exactly one per independent batch
    expect(mockChatSessionRepository.appendMessage).toHaveBeenCalledTimes(2);

    const firstMsg = mockChatSessionRepository.appendMessage.mock.calls[0][0];
    const secondMsg = mockChatSessionRepository.appendMessage.mock.calls[1][0];

    expect(firstMsg.metadata.documentsName).toEqual(["first_batch.pdf"]);
    expect(secondMsg.metadata.documentsName).toEqual(["second_batch.pdf"]);
  });
});
