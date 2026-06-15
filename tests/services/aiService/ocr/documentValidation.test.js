/* global describe, it, expect */
const {
  validateDocument,
  normalizeMime,
  detectSignatureMime,
} = require("../../../../src/services/aiService/ocr/documentValidation");

const {
  CorruptedFileError,
  FileTooLargeError,
  UnsupportedDocumentError,
} = require("../../../../src/services/aiService/ocr/ocrErrors");

describe("documentValidation", () => {
  describe("normalizeMime", () => {
    it("should normalize declared mime types", () => {
      expect(normalizeMime("report.pdf", "application/pdf")).toBe("application/pdf");
      expect(normalizeMime("photo.jpg", "image/jpg")).toBe("image/jpeg");
      expect(normalizeMime("scan.tif", "image/tif")).toBe("image/tiff");
    });

    it("should infer mime from extension if explicit mime type is missing", () => {
      expect(normalizeMime("report.pdf", null)).toBe("application/pdf");
      expect(normalizeMime("photo.png", "")).toBe("image/png");
      expect(normalizeMime("scan.webp", undefined)).toBe("image/webp");
    });
  });

  describe("detectSignatureMime", () => {
    it("should return null for empty or too short buffers", () => {
      expect(detectSignatureMime(null)).toBeNull();
      expect(detectSignatureMime(Buffer.from([]))).toBeNull();
      expect(detectSignatureMime(Buffer.from([0x25, 0x50]))).toBeNull();
    });

    it("should detect PDF signature", () => {
      const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
      expect(detectSignatureMime(buf)).toBe("application/pdf");
    });

    it("should detect PNG signature", () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(detectSignatureMime(buf)).toBe("image/png");
    });

    it("should detect JPEG signature", () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      expect(detectSignatureMime(buf)).toBe("image/jpeg");
    });

    it("should detect WEBP signature", () => {
      const buf = Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("WEBP"),
      ]);
      expect(detectSignatureMime(buf)).toBe("image/webp");
    });

    it("should detect TIFF signature", () => {
      const tiff1 = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
      const tiff2 = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
      expect(detectSignatureMime(tiff1)).toBe("image/tiff");
      expect(detectSignatureMime(tiff2)).toBe("image/tiff");
    });
  });

  describe("validateDocument", () => {
    it("should throw CorruptedFileError if buffer is empty", () => {
      expect(() => {
        validateDocument({ buffer: null, filename: "test.pdf" });
      }).toThrow(CorruptedFileError);

      expect(() => {
        validateDocument({ buffer: Buffer.from([]), filename: "test.pdf" });
      }).toThrow(CorruptedFileError);
    });

    it("should throw FileTooLargeError if file exceeds size limit", () => {
      const largeBuffer = Buffer.alloc(30 * 1024 * 1024); // 30 MB
      expect(() => {
        validateDocument({
          buffer: largeBuffer,
          filename: "large.pdf",
          mimeType: "application/pdf",
        });
      }).toThrow(FileTooLargeError);
    });

    it("should throw UnsupportedDocumentError for unknown mime types", () => {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      expect(() => {
        validateDocument({ buffer: buf, filename: "unknown.txt", mimeType: "text/plain" });
      }).toThrow(UnsupportedDocumentError);
    });

    it("should throw UnsupportedDocumentError if mime is unsupported", () => {
      const buf = Buffer.from([0x49, 0x49, 0x2a, 0x00]); // TIFF signature
      // TIFF is not in the configured SUPPORTED_MIME set for local OCR inline processing
      expect(() => {
        validateDocument({ buffer: buf, filename: "report.tiff", mimeType: "image/tiff" });
      }).toThrow(UnsupportedDocumentError);
    });

    it("should pass for supported formats and signatures", () => {
      const pdfBuf = Buffer.from([0x25, 0x50, 0x44, 0x46]);
      const result = validateDocument({
        buffer: pdfBuf,
        filename: "report.pdf",
        mimeType: "application/pdf",
      });
      expect(result).toEqual({ mimeType: "application/pdf" });
    });
  });
});
