const documentService = require("../../src/services/document.service");
const patientRepository = require("../../src/repositories/patientRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const objectStorageService = require("../../src/services/objectStorage.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const documentIdentityService = require("../../src/services/documentIdentity.service");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/documentProcessingJobRepository");
jest.mock("../../src/services/objectStorage.service");
jest.mock("../../src/clients/aiServiceClient");
jest.mock("pdf-parse", () => jest.fn(async () => ({ numpages: 1 })));

describe("Multi-Document Upload Isolation & Canonical Identity Resolution", () => {
  const patientId = "a1111111-1111-4111-a111-111111111111";

  beforeEach(() => {
    jest.clearAllMocks();

    patientRepository.findById.mockResolvedValue({
      id: patientId,
      preferredLanguage: "english",
    });

    objectStorageService.uploadFile.mockImplementation(async ({ fileKey }) => ({
      fileKey,
      s3Key: fileKey,
      s3Bucket: "health-vault-documents",
      storageProvider: "s3",
    }));

    documentRepository.upsertInitialDocument.mockImplementation(async (data) => ({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    documentProcessingJobRepository.createQueuedJob.mockImplementation(async (data) => ({
      id: `job-${data.fileKey}`,
      fileKey: data.fileKey,
      userId: data.userId,
      status: "QUEUED",
      metadata: data.metadata || {},
      checkpointData: data.checkpointData || {},
    }));

    aiServiceClient.dispatchDocumentProcessing.mockResolvedValue({
      status: "QUEUED",
    });
  });

  test("uploading multiple files generates distinct fileKeys, s3Keys, documentIds, and dispatches each file with its own isolated identity", async () => {
    const files = [
      { originalname: "fileA.pdf", mimetype: "application/pdf", buffer: Buffer.from("A"), size: 1 },
      { originalname: "fileB.pdf", mimetype: "application/pdf", buffer: Buffer.from("B"), size: 1 },
      { originalname: "fileC.pdf", mimetype: "application/pdf", buffer: Buffer.from("C"), size: 1 },
    ];

    const res = await documentService.uploadDocuments(files, patientId);

    expect(res.total).toBe(3);
    expect(res.documents).toHaveLength(3);

    const fileKeys = res.documents.map((d) => d.fileKey);
    const documentIds = res.documents.map((d) => d.documentId);
    const streamUrls = res.documents.map((d) => d.streamUrl);

    // 1. All fileKeys must be unique and start with doc_
    expect(new Set(fileKeys).size).toBe(3);
    fileKeys.forEach((fk) => expect(fk).toMatch(/^doc_/));

    // 2. All documentIds must be unique valid UUIDs
    expect(new Set(documentIds).size).toBe(3);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    documentIds.forEach((id) => expect(id).toMatch(uuidRegex));

    // 3. Stream URLs must target each file's specific fileKey
    streamUrls.forEach((url, idx) => {
      expect(url).toBe(`/sse/files/${fileKeys[idx]}/stream`);
    });

    // 4. Upserted documents in DB must be 3 distinct records with matching documentIds
    expect(documentRepository.upsertInitialDocument).toHaveBeenCalledTimes(3);
    const upsertedDocIds = documentRepository.upsertInitialDocument.mock.calls.map((c) => c[0].id);
    expect(upsertedDocIds).toEqual(documentIds);

    // 5. Python dispatch must have been called 3 times, each with its own documentId and storage pointer
    expect(aiServiceClient.dispatchDocumentProcessing).toHaveBeenCalledTimes(3);
    const dispatchedDocIds = aiServiceClient.dispatchDocumentProcessing.mock.calls.map(
      (c) => c[0].documentId,
    );
    expect(dispatchedDocIds).toEqual(documentIds);
  });

  test("documentIdentityService correctly identifies UUID vs logical fileKey", () => {
    expect(documentIdentityService.isUuid("11111111-1111-4111-a111-111111111111")).toBe(true);
    expect(documentIdentityService.isUuid("doc_abc123")).toBe(false);
    expect(documentIdentityService.isLogicalFileKey("doc_abc123")).toBe(true);
    expect(documentIdentityService.isLogicalFileKey("11111111-1111-4111-a111-111111111111")).toBe(
      false,
    );
  });
});
