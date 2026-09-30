const aiServiceClient = require("../../src/clients/aiServiceClient");
const {
  validatePreUploadDocument,
  MAX_FILE_SIZE_BYTES,
  validationCache,
} = require("../../src/services/documentPreValidation.service");

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
  }))
);

describe("documentPreValidation.service", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    validationCache.clear();
  });

  it("rejects files that exceed 25 MB", async () => {
    const file = {
      originalname: "large-report.pdf",
      size: MAX_FILE_SIZE_BYTES + 1024,
      buffer: Buffer.from("%PDF-1.4 dummy"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("FILE_TOO_LARGE");
    expect(result.title).toBe("File is too large");
    expect(result.message).toBe("Maximum allowed size is 25 MB.");
  });

  it("rejects unsupported file extensions (e.g. .txt)", async () => {
    const file = {
      originalname: "example.txt",
      size: 1024,
      buffer: Buffer.from("hello world"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_TYPE");
    expect(result.title).toBe("Unsupported file type");
    expect(result.message).toContain("This file type isn't supported");
  });

  it("rejects corrupted files with invalid magic bytes", async () => {
    const file = {
      originalname: "damaged-report.pdf",
      size: 2048,
      buffer: Buffer.from("NOT_A_PDF_HEADER_DATA_12345"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("CORRUPTED_FILE");
    expect(result.title).toBe("File couldn't be read");
    expect(result.message).toBe("This file appears to be corrupted.");
  });

  it("identifies non-medical document via canonical AI validation (e.g. electricity bill)", async () => {
    jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
      isMedical: false,
      confidence: 0.98,
      documentType: null,
      reason: "This document is an electricity utility invoice, not a medical document.",
    });

    const file = {
      originalname: "electricity-bill.pdf",
      size: 50000,
      buffer: Buffer.from("%PDF-1.4 ... valid header"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("NON_MEDICAL");
    expect(result.title).toBe("Not a medical document");
    expect(result.message).toBe(
      "This document is an electricity utility invoice, not a medical document."
    );
  });

  it("accepts valid medical PDF document via canonical AI validation", async () => {
    jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
      isMedical: true,
      confidence: 0.95,
      documentType: "LAB_REPORT",
      reason: "Laboratory blood examination report",
    });

    const file = {
      originalname: "blood-report.pdf",
      size: 200000,
      buffer: Buffer.from("%PDF-1.4 ... valid header"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(true);
    expect(result.documentType).toBe("LAB_REPORT");
  });

  it("fails open when canonical AI validation service is temporarily unavailable", async () => {
    jest.spyOn(aiServiceClient, "validateMedicalDocument").mockRejectedValueOnce(
      new Error("FastAPI connection refused / timeout")
    );

    const file = {
      originalname: "scanned-prescription.pdf",
      size: 350000,
      buffer: Buffer.from("%PDF-1.4 ... valid header"),
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(true);
  });

  it("accepts valid JPEG image via sharp metadata check and canonical AI validation", async () => {
    jest.spyOn(aiServiceClient, "validateMedicalDocument").mockResolvedValueOnce({
      isMedical: true,
      confidence: 0.92,
      documentType: "PRESCERIPTION",
    });

    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = {
      originalname: "prescription.jpg",
      size: 15000,
      buffer: jpegBuffer,
    };
    const result = await validatePreUploadDocument(file);
    expect(result.isValid).toBe(true);
  });
});
