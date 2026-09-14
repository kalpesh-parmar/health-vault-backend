const fs = require("fs");
const path = require("path");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const { ocrService } = require("../../src/services/ai/ocr/ocr.service");
const { NonMedicalDocumentException } = require("../../src/exceptions/appError");
const { ocrPageCache } = require("../../src/helpers/ocrCache.helper");

describe("Phase HF-3: Medical Document Gate Hardening & Fail-Open TDD Suite", () => {
  const tmpFilePath = path.resolve(__dirname, "../scratch/test_medical_sample.jpg");

  beforeAll(() => {
    const scratchDir = path.dirname(tmpFilePath);
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
    // Create a 1x1 valid dummy JPEG buffer for testing
    fs.writeFileSync(
      tmpFilePath,
      Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
        0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b,
        0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
        0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31,
        0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff,
        0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00,
        0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xbf, 0x00, 0xff, 0xd9,
      ]),
    );
  });

  afterAll(() => {
    if (fs.existsSync(tmpFilePath)) {
      try {
        fs.unlinkSync(tmpFilePath);
      } catch (err) {
        if (err) {
          // cleanup ignore
        }
      }
    }
  });

  beforeEach(() => {
    ocrPageCache.clearOcrCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    ocrPageCache.clearOcrCache();
    jest.restoreAllMocks();
  });

  // T-A: Real medical .jpg (image attached) -> classified medical, NOT rejected
  test("T-A: Real medical .jpg image classifies as medical and is NOT rejected", async () => {
    const medicalBuffer = fs.readFileSync(tmpFilePath);

    const mockChat = jest.spyOn(ollamaClient, "chat").mockResolvedValue(
      JSON.stringify({
        pageType: "MEDICAL",
        rawText: "Dr. Bakul Patel\nPatient: Rajesh Kumar\nRx: Tab. Metformin 500mg 1-0-1",
      }),
    );

    const mockGenerate = jest.spyOn(ollamaClient, "generate").mockResolvedValue(
      JSON.stringify({
        documentType: "PRESCRIPTION",
        patientName: "Rajesh Kumar",
        doctorName: "Dr. Bakul Patel",
        medications: [{ name: "Tab. Metformin 500mg", dosage: "1-0-1" }],
        rawText: "Dr. Bakul Patel\nPatient: Rajesh Kumar\nRx: Tab. Metformin 500mg 1-0-1",
      }),
    );

    const result = await ocrService.extractMedicalData({
      buffer: medicalBuffer,
      filename: "prescription.jpg",
      mimeType: "image/jpeg",
    });

    expect(result).toBeDefined();
    const parsed = JSON.parse(result);
    expect(parsed.documentType).toBe("PRESCRIPTION");
    expect(parsed.medicalExtraction.patientInfo.name).toBe("Rajesh Kumar");
    expect(mockChat).toHaveBeenCalled();

    mockChat.mockRestore();
    mockGenerate.mockRestore();
  });

  // T-B: Classifier returns null/garbage -> RETRYABLE UNKNOWN, NOT fatal NON_MEDICAL
  test("T-B: Classifier returns null or unparseable output -> fails open to RETRYABLE_UNKNOWN, NOT fatal NON_MEDICAL", async () => {
    const testBuffer = fs.readFileSync(tmpFilePath);

    // Mock vision model returning null / empty content / unparseable output
    const mockChat = jest.spyOn(ollamaClient, "chat").mockResolvedValue("");

    // Should NOT throw NonMedicalDocumentException
    // If all pages are unclassifiable, it should either retry and fail open or throw a retryable error, NOT NonMedicalDocumentException
    let thrownError = null;
    try {
      await ocrService.extractMedicalData({
        buffer: testBuffer,
        filename: "unparseable.jpg",
        mimeType: "image/jpeg",
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError).not.toBeInstanceOf(NonMedicalDocumentException);
    expect(thrownError.errorCode || thrownError.name).not.toBe("NON_MEDICAL_DOCUMENT");

    mockChat.mockRestore();
  });

  // T-C: Genuine non-medical image (image attached + confident reply) -> NON_MEDICAL
  test("T-C: Genuine non-medical image with confident non-medical classification throws NonMedicalDocumentException", async () => {
    const testBuffer = fs.readFileSync(tmpFilePath);

    const mockChat = jest.spyOn(ollamaClient, "chat").mockResolvedValue(
      JSON.stringify({
        pageType: "OTHER",
        rawText: "",
      }),
    );

    await expect(
      ocrService.extractMedicalData({
        buffer: testBuffer,
        filename: "receipt.jpg",
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow(NonMedicalDocumentException);

    mockChat.mockRestore();
  });

  // T-D: The qwen3-vl request always contains a non-empty images[] entry
  test("T-D: The qwen3-vl request always contains a non-empty images[] entry with valid base64", async () => {
    const testBuffer = fs.readFileSync(tmpFilePath);

    let capturedMessages = null;
    const mockChat = jest.spyOn(ollamaClient, "chat").mockImplementation(async (messages) => {
      capturedMessages = messages;
      return JSON.stringify({
        pageType: "MEDICAL",
        rawText: "Prescription text",
      });
    });

    const mockGenerate = jest.spyOn(ollamaClient, "generate").mockResolvedValue(
      JSON.stringify({
        documentType: "PRESCRIPTION",
        patientName: "Patient A",
        rawText: "Prescription text",
      }),
    );

    // Case 1: Provided as buffer
    await ocrService.extractMedicalData({
      buffer: testBuffer,
      filename: "sample1.jpg",
      mimeType: "image/jpeg",
    });

    expect(capturedMessages).toBeDefined();
    expect(Array.isArray(capturedMessages)).toBe(true);
    expect(capturedMessages[0].images).toBeDefined();
    expect(capturedMessages[0].images.length).toBeGreaterThan(0);
    expect(typeof capturedMessages[0].images[0]).toBe("string");
    expect(capturedMessages[0].images[0].length).toBeGreaterThan(10);

    // Case 2: Provided as path (disk streaming scenario)
    capturedMessages = null;
    ocrPageCache.clearOcrCache();

    await ocrService.extractMedicalData({
      path: tmpFilePath,
      filename: "sample2.jpg",
      mimeType: "image/jpeg",
    });

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages[0].images).toBeDefined();
    expect(capturedMessages[0].images.length).toBeGreaterThan(0);
    expect(typeof capturedMessages[0].images[0]).toBe("string");
    expect(capturedMessages[0].images[0].length).toBeGreaterThan(10);

    mockChat.mockRestore();
    mockGenerate.mockRestore();
  });
});
