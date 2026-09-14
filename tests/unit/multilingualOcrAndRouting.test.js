const { detectLanguages } = require("../../src/helpers/languageDetector.helper");
const { ocrPageCache, OcrPageCache } = require("../../src/helpers/ocrCache.helper");
const prompts = require("../../src/services/ai/prompts");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const { ocrService } = require("../../src/services/ai/ocr/ocr.service");
const { ocrOrchestrator } = require("../../src/services/ai/ocr/ocr.orchestrator");

describe("Phase 5: High-Speed Multilingual OCR & Vision Routing Unit Tests", () => {
  beforeEach(() => {
    ocrPageCache.clearOcrCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    ocrPageCache.clearOcrCache();
    jest.restoreAllMocks();
  });

  describe("1. Language & Script Identification (REQ-02)", () => {
    test("Detects English for standard Latin-script medical prescriptions", () => {
      const text = [
        "Dr. Bakul Patel, MD",
        "Patient: Rajesh Kumar, Age: 45, Gender: Male",
        "Rx: Tab. Metformin 500mg 1-0-1 after food x 30 days",
        "Diagnosis: Type 2 Diabetes Mellitus",
      ].join("\n");

      const result = detectLanguages(text);
      expect(result.detectedLanguages).toContain("english");
      expect(result.primaryLanguage).toBe("english");
      expect(result.isIndic).toBe(false);
    });

    test("Detects Gujarati + English for mixed Gujarati prescriptions (REQ-01)", () => {
      const text = [
        "ડૉ. બકુલ પટેલ - એમ.ડી. ફિઝિશિયન",
        "દર્દીનું નામ: રમેશભાઈ પટેલ, ઉંમર: ૫૨ વર્ષ",
        "તપાસ: તાવ અને ગળામાં દુખાવો",
        "દવાઓ:",
        "Tab. Caldison D3 1-0-0",
        "Cap. Amoxicillin 500mg 1-0-1 જમ્યા પછી",
      ].join("\n");

      const result = detectLanguages(text);
      expect(result.detectedLanguages).toContain("gujarati");
      expect(result.detectedLanguages).toContain("english");
      expect(result.primaryLanguage).toBe("gujarati");
      expect(result.isIndic).toBe(true);
    });

    test("Detects Hindi + English for Hindi prescriptions", () => {
      const text = [
        "डॉ. राजेश शर्मा, एमबीबीएस",
        "मरीज का नाम: अमित वर्मा, उम्र: 38 वर्ष",
        "लक्षण: पिछले तीन दिन से तेज बुखार और सिरदर्द",
        "कृपया ये दवाई समय पर लें:",
        "Tab. Paracetamol 650mg 1-1-1",
        "Tab. Cetirizine 10mg 0-0-1",
      ].join("\n");

      const result = detectLanguages(text);
      expect(result.detectedLanguages).toContain("hindi");
      expect(result.detectedLanguages).toContain("english");
      expect(result.primaryLanguage).toBe("hindi");
      expect(result.isIndic).toBe(true);
    });

    test("Disambiguates Marathi from Hindi using ळ (Lla) and Marathi keywords", () => {
      const text = [
        "डॉ. विठ्ठल पाटील, एम.डी.",
        "रुग्णाचे नाव: सचिन मोहिते, वय: ४८",
        "तपासणी: उच्च रक्तदाब आणि डोकेदुखी",
        "औषधे व गोळ्या:",
        "Tab. Telmisartan 40mg 1-0-0 सकाळी घ्यावे",
        "सकाळ-संध्याकाळ नियमित चालणे आणि जेवणानंतर औषध घेणे",
      ].join("\n");

      const result = detectLanguages(text);
      expect(result.detectedLanguages).toContain("marathi");
      expect(result.detectedLanguages).toContain("english");
      expect(result.primaryLanguage).toBe("marathi");
      expect(result.isIndic).toBe(true);
    });

    test("Detects Tamil + English for Tamil medical reports", () => {
      const text = [
        "மருத்துவர்: டாக்டர். சுரேஷ்",
        "நோயாளி பெயர்: கார்த்திக், வயது: 42",
        "மருந்துகள்:",
        "Tab. Metformin 500mg 1-0-1",
        "உணவுக்கு பின் எடுத்துக்கொள்ளவும்",
      ].join("\n");

      const result = detectLanguages(text);
      expect(result.detectedLanguages).toContain("tamil");
      expect(result.detectedLanguages).toContain("english");
      expect(result.primaryLanguage).toBe("tamil");
      expect(result.isIndic).toBe(true);
    });

    test("Handles empty or null text safely with fallback", () => {
      const resNull = detectLanguages(null);
      expect(resNull.detectedLanguages).toEqual(["english"]);
      expect(resNull.primaryLanguage).toBe("english");
      expect(resNull.isIndic).toBe(false);

      const resHint = detectLanguages("", "gujarati");
      expect(resHint.detectedLanguages).toContain("gujarati");
      expect(resHint.detectedLanguages).toContain("english");
    });
  });

  describe("2. Multilingual OCR Prompting (REQ-01)", () => {
    test("PAGE_CLASSIFY_OCR_PROMPT mandates multilingual mixed-script fidelity", () => {
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain(
        "MULTILINGUAL & MIXED-SCRIPT PRESERVATION",
      );
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain(
        "English, Gujarati, Hindi, Marathi, and Tamil",
      );
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("Always preserve medication brand names");
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("Never translate medication names");
    });
  });

  describe("3. Ollama keep_alive: -1 Invariant (C1, C2)", () => {
    test("OllamaClient.chat sends keep_alive: -1 by default", async () => {
      const mockRequest = jest
        .spyOn(ollamaClient, "requestWithRetry")
        .mockImplementation(async (config) => {
          expect(config.data.keep_alive).toBe(-1);
          return {
            data: {
              message: { content: "test" },
              done_reason: "stop",
            },
          };
        });

      await ollamaClient.chat([{ role: "user", content: "hi" }], "qwen3-vl:latest");
      expect(mockRequest).toHaveBeenCalled();
    });

    test("OllamaClient.generate sends keep_alive: -1 by default", async () => {
      const mockRequest = jest
        .spyOn(ollamaClient, "requestWithRetry")
        .mockImplementation(async (config) => {
          expect(config.data.keep_alive).toBe(-1);
          return {
            data: {
              response: "test",
              done_reason: "stop",
            },
          };
        });

      await ollamaClient.generate("prompt", "medgemma:4b");
      expect(mockRequest).toHaveBeenCalled();
    });
  });

  describe("4. Page Content Hash Caching (Speed Optimization)", () => {
    test("Generates consistent SHA-256 hashes for buffers and strings", () => {
      const buffer = Buffer.from("test-image-content-page-1");
      const hash1 = ocrPageCache.hashPageContent(buffer);
      const hash2 = ocrPageCache.hashPageContent(buffer);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    test("Caches page results and serves cache hits instantaneously", () => {
      const pageHash = "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678";
      const ocrResult = {
        pageType: "MEDICAL",
        rawText: "Prescription for John Doe\nTab. Metformin 500mg",
      };

      expect(ocrPageCache.getPageOcr(pageHash)).toBeNull();
      ocrPageCache.setPageOcr(pageHash, ocrResult);

      const cached = ocrPageCache.getPageOcr(pageHash);
      expect(cached).toEqual(ocrResult);

      const stats = ocrPageCache.getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    test("Evicts oldest item when exceeding maxSize", () => {
      const miniCache = new OcrPageCache(2, 60000);
      miniCache.setPageOcr("hash1", { page: 1 });
      miniCache.setPageOcr("hash2", { page: 2 });
      miniCache.setPageOcr("hash3", { page: 3 });

      expect(miniCache.getPageOcr("hash1")).toBeNull(); // evicted
      expect(miniCache.getPageOcr("hash2")).toEqual({ page: 2 });
      expect(miniCache.getPageOcr("hash3")).toEqual({ page: 3 });
    });
  });

  describe("5. End-to-End Multilingual Routing & Caching Integration", () => {
    test("extractMedicalData uses page cache on repeated scan without hitting Ollama", async () => {
      const testBuffer = Buffer.from("fake_prescription_image_page_1");
      const mockOllamaChat = jest.spyOn(ollamaClient, "chat").mockResolvedValue(
        JSON.stringify({
          pageType: "MEDICAL",
          rawText: "દર્દીનું નામ: હરેશ પટેલ\nTab. Pantocid 40mg 1-0-0",
        }),
      );

      const mockOllamaGenerate = jest.spyOn(ollamaClient, "generate").mockResolvedValue(
        JSON.stringify({
          documentType: "PRESCRIPTION",
          patientName: "Haresh Patel",
          medications: [{ name: "Tab. Pantocid 40mg", dosage: "1-0-0" }],
          rawText: "દર્દીનું નામ: હરેશ પટેલ\nTab. Pantocid 40mg 1-0-0",
        }),
      );

      // First run: cache miss, hits ollamaClient.chat
      const result1 = await ocrService.extractMedicalData({
        buffer: testBuffer,
        filename: "prescription.jpg",
        mimeType: "image/jpeg",
        userLanguage: "gujarati",
      });

      const parsed1 = JSON.parse(result1);
      expect(mockOllamaChat).toHaveBeenCalledTimes(1);
      expect(parsed1.detectedLanguages).toContain("gujarati");
      expect(parsed1.detectedLanguages).toContain("english");

      // Second run with same page buffer: cache hit, skips ollamaClient.chat!
      const result2 = await ocrService.extractMedicalData({
        buffer: testBuffer,
        filename: "prescription.jpg",
        mimeType: "image/jpeg",
        userLanguage: "gujarati",
      });

      const parsed2 = JSON.parse(result2);
      // Chat should STILL be 1 because page 1 was served from cache!
      expect(mockOllamaChat).toHaveBeenCalledTimes(1);
      expect(parsed2.detectedLanguages).toContain("gujarati");

      mockOllamaChat.mockRestore();
      mockOllamaGenerate.mockRestore();
    });

    test("ocrOrchestrator exposes detectedLanguages in metadata and structuredDocument", async () => {
      const mockResult = JSON.stringify({
        pages: [{ page: 1, text: "Patient Name: Anita\nTab. Dolo 650mg" }],
        detectedLanguages: ["hindi", "english"],
        medicalExtraction: {
          documentType: "PRESCRIPTION",
          detectedLanguages: ["hindi", "english"],
          patientInfo: { name: "Anita" },
          medications: [{ name: "Tab. Dolo 650mg" }],
        },
      });

      jest.spyOn(ocrService, "extractMedicalData").mockResolvedValue(mockResult);

      const orchestratorResult = await ocrOrchestrator.runFromBuffer({
        buffer: Buffer.from("dummy"),
        filename: "doc.jpg",
        mimeType: "image/jpeg",
      });

      expect(orchestratorResult.success).toBe(true);
      expect(orchestratorResult.metadata.detectedLanguages).toEqual(["hindi", "english"]);
      expect(orchestratorResult.structuredDocument.detectedLanguages).toEqual(["hindi", "english"]);
    });
  });
});
