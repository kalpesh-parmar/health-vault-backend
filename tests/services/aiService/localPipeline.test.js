const axios = require("axios");
const { StatusCodes } = require("http-status-codes");
const { ollamaClient } = require("../../../src/services/ai/clients/ollamaClient");
const { ocrService } = require("../../../src/services/ai/ocr/ocr.service");
const { chatService: chatbotService } = require("../../../src/services/ai/chat/chat.service");
const { embeddingService } = require("../../../src/services/ai/chat/embedding.service");
const v1Controller = require("../../../src/controllers/v1.controller");

jest.mock("axios", () => {
  const mockAxios = jest.fn();
  mockAxios.post = jest.fn();
  mockAxios.get = jest.fn();
  return mockAxios;
});

jest.mock("../../../src/configs/db", () => {
  const mockReturning = jest.fn().mockResolvedValue([
    {
      id: "doc-123",
      fileName: "report.pdf",
      filePath: "gs://bucket/key.pdf",
      fileType: "application/pdf",
      fileSize: 1024,
      ocrStatus: "completed",
      reportDate: new Date(),
      hospitalName: "City Hospital",
      doctorName: "Dr. Smith",
      remarks: "Follow-up in a week",
      summaryGujarati: "summary in gujarati",
    },
  ]);
  const mockValues = jest.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = jest.fn().mockReturnValue({ values: mockValues });
  return {
    db: {
      insert: mockInsert,
    },
  };
});

describe("Local AI Pipeline Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("1. Ollama Client Service", () => {
    it("should process normal chat response correctly", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: "Hello I am your assistant",
          },
          done: true,
        },
      });

      const response = await ollamaClient.chat([{ role: "user", content: "Hi" }], "qwen2.5:14b");
      expect(response).toBe("Hello I am your assistant");
    });

    it("should handle thinking block in chat message response", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: "",
            thinking: "Thinking process...",
          },
          done: true,
        },
      });

      const response = await ollamaClient.chat([{ role: "user", content: "Hi" }], "qwen2.5:14b");
      expect(response).toBe("Thinking process...");
    });

    it("should call onChunk in chatStream", async () => {
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === "data") {
            callback(
              Buffer.from(
                JSON.stringify({ message: { content: "Streaming " }, done: false }) + "\n",
              ),
            );
            callback(
              Buffer.from(JSON.stringify({ message: { content: "response" }, done: true }) + "\n"),
            );
          }
        }),
      };

      axios.mockResolvedValueOnce({
        data: mockStream,
      });

      const chunks = [];
      await ollamaClient.chatStream(
        [{ role: "user", content: "Stream me" }],
        "qwen2.5:14b",
        (chunk) => chunks.push(chunk),
      );

      expect(chunks).toEqual(["Streaming ", "response"]);
    });

    it("should generate embeddings and normalize dimensions to 1024", async () => {
      axios.mockResolvedValueOnce({
        data: {
          embedding: new Array(512).fill(0.5),
        },
      });

      const vector = await embeddingService.embedText("Embed me");
      expect(vector).toHaveLength(1024);
      expect(vector[0]).toBe(0.5);
      expect(vector[1000]).toBe(0); // padded
    });
  });

  describe("2. OCR & Document Understanding (qwen3-vl)", () => {
    it("should validate a medical document successfully", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: JSON.stringify({
              isMedicalDocument: true,
              documentType: "Prescription",
              reason: "Contains doctor prescription layout",
            }),
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("mock image"),
        mimeType: "image/png",
        originalname: "prescription.png",
      };

      const result = await ocrService.validateDocument(fileMock);
      expect(result.status).toBe("SUCCESS");
      expect(result.isMedicalDocument).toBe(true);
      expect(result.documentType).toBe("Prescription");
    });

    it("should flag a non-medical document", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: JSON.stringify({
              isMedicalDocument: false,
              documentType: "None",
              reason: "This is a gaming screenshot",
            }),
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("gaming screenshot"),
        mimeType: "image/jpeg",
        originalname: "screenshot.jpg",
      };

      const result = await ocrService.validateDocument(fileMock);
      expect(result.status).toBe("SUCCESS");
      expect(result.isMedicalDocument).toBe(false);
    });

    it("should perform OCR on Gujarati prescriptions and detect Gujarati language", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: "ડો. કલ્પેશ પટેલ - તાવ અને શરદીની દવા", // Gujarati text
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("gujarati doc"),
        mimeType: "image/png",
        originalname: "gujarati.png",
      };

      const result = await ocrService.extractText(fileMock);
      expect(result.rawText).toContain("ડો.");
      expect(result.detectedLanguages).toContain("gujarati");
      expect(result.detectedLanguages).toContain("english");
      expect(result.pageCount).toBe(1);
    });

    it("should perform OCR on English lab reports", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: "Max Healthcare. CBC Report. Hemoglobin: 14.2 g/dL",
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("english report"),
        mimeType: "image/png",
        originalname: "report.png",
      };

      const result = await ocrService.extractText(fileMock);
      expect(result.rawText).toContain("Hemoglobin: 14.2");
      expect(result.detectedLanguages).toEqual(["english"]);
    });
  });

  describe("3. Structured Medical Extraction & Fallbacks", () => {
    it("should extract structured data and validate using Zod", async () => {
      const mockExtraction = {
        patientName: "John Doe",
        age: 35,
        gender: "Male",
        reportDate: "2026-06-15",
        doctorName: "Dr. Smith",
        hospitalName: "City Hospital",
        diagnosis: "Mild Fever",
        medications: [
          {
            name: "Paracetamol",
            dosage: "500mg",
            frequency: "Three times daily",
            duration: "3 days",
            instructions: "After meals",
          },
        ],
        testResults: [
          {
            testName: "WBC Count",
            value: "7500",
            unit: "/uL",
            referenceRange: "4000-11000",
            status: "NORMAL",
          },
        ],
        remarks: "Rest for 3 days",
      };

      axios.mockResolvedValueOnce({
        data: {
          response: JSON.stringify(mockExtraction),
        },
      });

      const result = await ocrService.extractMedicalDataFromText("Patient: John Doe, Age: 35...");
      expect(result.patientName).toBe("John Doe");
      expect(result.age).toBe(35);
      expect(result.medications[0].name).toBe("Paracetamol");
      expect(result.testResults[0].status).toBe("NORMAL");
    });

    it("should repair malformed JSON response with trailing commas", async () => {
      const malformedJson = `{
        "patientName": "Jane Doe",
        "age": 28,, // double comma
        "medications": [
          { "name": "Aspirin", }, // trailing comma
        ],
      }`;

      axios.mockResolvedValueOnce({
        data: {
          response: malformedJson,
        },
      });

      const result = await ocrService.extractMedicalDataFromText("Patient Jane Doe...");
      expect(result.patientName).toBe("Jane Doe");
      expect(result.medications[0].name).toBe("Aspirin");
    });
  });

  describe("4. Gujarati Summary Service", () => {
    it("should generate Gujarati summary and keep English medical terms", async () => {
      axios.mockResolvedValueOnce({
        data: {
          response: "દર્દીને Diabetes છે અને તેના માટે Metformin દવા લેવાની સલાહ આપી છે.",
        },
      });

      const summary = await ocrService.generateSummary("Patient has Diabetes. Take Metformin.");
      expect(summary).toContain("Diabetes");
      expect(summary).toContain("Metformin");
      expect(summary).toContain("દર્દીને");
    });
  });

  describe("5. Chatbot Service with Auto-Language & Citations", () => {
    it("should detect language and retrieve context from RAG", async () => {
      // Mock Chat response
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content:
              "તમારો HbA1c 7.2% છે જે દર્શાવે છે કે તમને ડાયાબિટીસ (Diabetes) નિયંત્રણ બહાર છે. કૃપા કરીને ડોક્ટરનો સંપર્ક કરો.",
          },
        },
      });

      const messages = [{ role: "user", content: "મારો રિપોર્ટ શું કહે છે?" }];
      const chunks = [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          content: "Patient HbA1c is 7.2% (High)",
          sectionTitle: "HbA1c test",
          sourceType: "report",
        },
      ];
      const result = await chatbotService.qwenHealthChat(messages, "DOCUMENT_RAG", chunks);

      expect(result.answer).toContain("HbA1c 7.2%");
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0].chunkId).toBe("chunk-1");
    });
  });

  describe("6. OCR Detail Types & Corner Cases", () => {
    it("should process multi-page PDFs sequentially and combine text", async () => {
      const convertSpy = jest
        .spyOn(ocrService, "convertPdfToImages")
        .mockResolvedValueOnce(["base64-page1", "base64-page2"]);

      axios
        .mockResolvedValueOnce({ data: { message: { content: "Page 1 content" } } })
        .mockResolvedValueOnce({ data: { message: { content: "Page 2 content" } } });

      const fileMock = {
        buffer: Buffer.from("pdf buffer"),
        mimeType: "application/pdf",
        originalname: "multipage.pdf",
      };

      const result = await ocrService.extractText(fileMock);
      expect(result.pageCount).toBe(2);
      expect(result.rawText).toContain("Page 1 content");
      expect(result.rawText).toContain("Page 2 content");

      convertSpy.mockRestore();
    });

    it("should handle failed validation for blurred/corrupted files in validateDocument", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: JSON.stringify({
              isMedicalDocument: false,
              documentType: "None",
              reason: "The document is too blurry to read",
            }),
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("blurry image"),
        mimeType: "image/jpeg",
        originalname: "blurry.jpg",
      };

      const result = await ocrService.validateDocument(fileMock);
      expect(result.isMedicalDocument).toBe(false);
      expect(result.reason).toContain("blurry");
    });

    it("should perform OCR on mixed Gujarati-English reports and detect both languages", async () => {
      axios.mockResolvedValueOnce({
        data: {
          message: {
            content: "Patient Report: ૧૦૦ mg Glucose levels are normal.",
          },
        },
      });

      const fileMock = {
        buffer: Buffer.from("mixed report"),
        mimeType: "image/png",
        originalname: "mixed.png",
      };

      const result = await ocrService.extractText(fileMock);
      expect(result.rawText).toContain("Glucose levels");
      expect(result.detectedLanguages).toContain("gujarati");
      expect(result.detectedLanguages).toContain("english");
    });
  });

  describe("7. End-to-End API Controller Tests", () => {
    it("should successfully execute the full OCR Extract controller flow", async () => {
      const req = {
        auth: { userId: "user-123" },
        file: {
          buffer: Buffer.from("pdf data"),
          mimeType: "application/pdf",
          originalname: "report.pdf",
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const next = jest.fn();

      const processSpy = jest.spyOn(ocrService, "processAndStoreSynchronously").mockResolvedValue({
        document: {
          id: "doc-123",
          fileName: "report.pdf",
          filePath: "gs://bucket/key.pdf",
          fileType: "application/pdf",
          fileSize: 1024,
          reportDate: "2026-06-15",
          hospitalName: "City Hospital",
          doctorName: "Dr. Smith",
          remarks: "None",
          summaryGujarati: "આ એક સારાંશ છે.",
          ocrStatus: "COMPLETED",
          ocrExtractedText: "Mock OCR Text",
        },
        ocrResult: {
          detectedLanguages: ["en"],
          pageCount: 1,
        },
        structuredData: {
          patientName: "John Doe",
          age: 45,
          gender: "Male",
          reportDate: "2026-06-15",
          doctorName: "Dr. Smith",
          hospitalName: "City Hospital",
          diagnosis: "Normal",
          medications: [],
          testResults: [],
          remarks: "None",
        },
      });

      await v1Controller.ocrExtract(req, res, next);

      expect(processSpy).toHaveBeenCalledWith({ file: req.file, userId: "user-123" });
      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "SUCCESS",
          message: "Document processed and stored successfully",
        }),
      );

      processSpy.mockRestore();
    });
  });
});
