const patientService = require("../../src/services/patient.service");
const documentService = require("../../src/services/document.service");
const patientRepository = require("../../src/repositories/patientRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const objectStorageService = require("../../src/services/objectStorage.service");
const { UnauthorizedException, NotFoundException } = require("../../src/exceptions/appError");

jest.mock("../../src/configs/db", () => {
  return {
    db: {
      transaction: jest.fn().mockImplementation(async (cb) => {
        return cb({});
      }),
    },
  };
});

describe("Phase 2 Upload APIs — Service Tests", () => {
  const mockPatientId = "11111111-1111-1111-1111-111111111111";
  const mockPatient = {
    id: mockPatientId,
    patientCode: "P-100",
    profileImageKey: "profiles/old-key.jpg",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(patientRepository, "findById").mockResolvedValue(mockPatient);
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({
      ...mockPatient,
      profileImageKey: "profiles/new-key.png",
    });
    jest.spyOn(objectStorageService, "uploadFile").mockResolvedValue({
      fileKey: "profiles/new-key.png",
      fileName: "test.png",
      fileType: "image/png",
      fileSize: 1024,
      s3Bucket: "test-bucket",
    });
    jest
      .spyOn(objectStorageService, "getSignedFileUrl")
      .mockResolvedValue("https://signed-url.com/file");
    jest.spyOn(objectStorageService, "deleteFile").mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("POST /patient/:patientId/profile/upload", () => {
    it("should successfully upload profile image and update patient profileImageKey", async () => {
      const mockFile = {
        originalname: "avatar.png",
        mimetype: "image/png",
        size: 1024 * 500,
        buffer: Buffer.from("fake-image"),
      };

      const result = await patientService.uploadProfileImage(
        mockPatientId,
        mockFile,
        mockPatientId,
      );

      expect(patientRepository.findById).toHaveBeenCalledWith(mockPatientId);
      expect(objectStorageService.uploadFile).toHaveBeenCalledWith(
        mockFile,
        "profiles",
        mockPatientId,
      );
      expect(objectStorageService.getSignedFileUrl).toHaveBeenCalledWith("profiles/new-key.png");
      expect(result.profileImageUrl).toBe("https://signed-url.com/file");
    });

    it("should throw UnauthorizedException if authUserId does not match patientId", async () => {
      const mockFile = { originalname: "avatar.png", mimetype: "image/png", size: 100 };
      await expect(
        patientService.uploadProfileImage(mockPatientId, mockFile, "other-user-id"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw NotFoundException if patient does not exist", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue(null);
      const mockFile = { originalname: "avatar.png", mimetype: "image/png", size: 100 };

      await expect(
        patientService.uploadProfileImage(mockPatientId, mockFile, mockPatientId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("POST /patient/:patientId/documents/upload", () => {
    it("should store multiple files, create DB records in transaction with ocrStatus pending, and return 201 response payload", async () => {
      const mockFiles = [
        { originalname: "report.pdf", mimetype: "application/pdf", size: 2048 },
        { originalname: "scan.png", mimetype: "image/png", size: 4096 },
      ];

      jest
        .spyOn(objectStorageService, "uploadFile")
        .mockResolvedValueOnce({
          fileKey: "documents/doc-1.pdf",
          fileName: "report.pdf",
          fileType: "application/pdf",
          fileSize: 2048,
          s3Bucket: "test-bucket",
        })
        .mockResolvedValueOnce({
          fileKey: "documents/doc-2.png",
          fileName: "scan.png",
          fileType: "image/png",
          fileSize: 4096,
          s3Bucket: "test-bucket",
        });

      jest.spyOn(documentRepository, "createMany").mockResolvedValue([
        {
          id: "doc-uuid-1",
          userId: mockPatientId,
          fileName: "report.pdf",
          filePath: "documents/doc-1.pdf",
          ocrStatus: "pending",
        },
        {
          id: "doc-uuid-2",
          userId: mockPatientId,
          fileName: "scan.png",
          filePath: "documents/doc-2.png",
          ocrStatus: "pending",
        },
      ]);

      const result = await documentService.uploadPatientDocuments(
        mockPatientId,
        mockFiles,
        mockPatientId,
      );

      expect(objectStorageService.uploadFile).toHaveBeenCalledTimes(2);
      expect(documentRepository.createMany).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].ocrStatus).toBe("pending");
      expect(result[0].signedUrl).toBe("https://signed-url.com/file");
    });

    it("should cleanup uploaded storage files on DB transaction failure", async () => {
      const mockFiles = [{ originalname: "report.pdf", mimetype: "application/pdf", size: 2048 }];

      jest.spyOn(objectStorageService, "uploadFile").mockResolvedValue({
        fileKey: "documents/doc-fail.pdf",
        fileName: "report.pdf",
        fileType: "application/pdf",
        fileSize: 2048,
      });

      jest
        .spyOn(documentRepository, "createMany")
        .mockRejectedValue(new Error("DB Connection Error"));

      await expect(
        documentService.uploadPatientDocuments(mockPatientId, mockFiles, mockPatientId),
      ).rejects.toThrow("DB Connection Error");

      expect(objectStorageService.deleteFile).toHaveBeenCalledWith("documents/doc-fail.pdf");
    });
  });
});
