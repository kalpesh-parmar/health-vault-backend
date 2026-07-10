const fileController = require("../../src/controllers/file.controller");
const uploadFileService = require("../../src/services/uploadFileService");
const { InvalidRequestException } = require("../../src/exceptions/appError");

jest.mock("../../src/services/uploadFileService");

describe("fileController - viewFile", () => {
  it("should throw InvalidRequestException if fileKey is missing", async () => {
    const req = { query: {} };
    const res = {};

    await expect(fileController.viewFile(req, res)).rejects.toThrow(InvalidRequestException);
  });

  it("should stream file with inline disposition for images and PDFs", async () => {
    const mockStream = {
      pipe: jest.fn(),
      on: jest.fn(),
    };
    uploadFileService.getFileStream.mockResolvedValue({
      stream: mockStream,
      contentType: "image/png",
      contentLength: 1024,
    });

    const req = { query: { fileKey: "patient/profile/avatar.png" } };
    const res = {
      setHeader: jest.fn(),
    };

    await fileController.viewFile(req, res);

    expect(uploadFileService.getFileStream).toHaveBeenCalledWith("patient/profile/avatar.png");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Length", 1024);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'inline; filename="avatar.png"',
    );
    expect(mockStream.pipe).toHaveBeenCalledWith(res);
  });

  it("should stream file with attachment disposition for other files", async () => {
    const mockStream = {
      pipe: jest.fn(),
      on: jest.fn(),
    };
    uploadFileService.getFileStream.mockResolvedValue({
      stream: mockStream,
      contentType: "text/csv",
      contentLength: 2048,
    });

    const req = { query: { fileKey: "documents/data.csv" } };
    const res = {
      setHeader: jest.fn(),
    };

    await fileController.viewFile(req, res);

    expect(uploadFileService.getFileStream).toHaveBeenCalledWith("documents/data.csv");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Length", 2048);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="data.csv"',
    );
    expect(mockStream.pipe).toHaveBeenCalledWith(res);
  });
});
