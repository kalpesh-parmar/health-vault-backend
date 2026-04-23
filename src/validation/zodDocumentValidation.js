const { z } = require("zod");
const messageConstant = require("../constant/messageConstant");
const { documentTypeEnum } = require("../enumData/documentType");
const { fileType } = require("../enumData/fileEnum");
const { statusType } = require("../enumData/ocrStatus");

const documentEnum = z.enum(documentTypeEnum, messageConstant.VALID_DOCUMENT);
const fileEnum = z.enum(fileType,messageConstant.ENTER_VALID_FILETYPE);
const ocrEnum = z.enum(statusType);
const UPPER_REGEX = /[A-Z]/;
const LOWER_CASE = /[a-z]/;
const NUMBER = /[0-9]/;
const SYMBOL = /[@$!%*?&]/;
const ALPHABETS = /^[A-Za-z\s]+$/s;

const fileName = z
  .string(messageConstant.NAME_REQUIRED)
  .min(2, messageConstant.NAME_TOO_SHORT)
  .max(255, messageConstant.NAME_TOO_LONG);

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const fileSize = z
    .string()
    .refine((val) => {
        const sizeInBytes = parseInt(val);
        return !isNaN(sizeInBytes) && sizeInBytes <= MAX_FILE_SIZE;},
  messageConstant.VALID_FILE_SIZE,
);
const fileStoragePath= z.string().min(1, "Storage path is required");
const ocrextractedText= z.string().optional().nullable();
const structuredExtractedData= z.string().optional().nullable();
const reportDate= z.coerce.date().optional().nullable();
const hospitalName= z.string().min(1, messageConstant.HSP_NAME_REQUIRE);
const doctorName= z.string().max(25,messageConstant.NAME_TOO_LONG);
const remarks= z.string().optional().nullable();

const DocumentSchema = z
  .object({
    documentType: documentEnum,
    fileName:fileName,
    fileStoragePath:fileStoragePath,
    fileType:fileEnum,
    fileSize:fileSize,
    OCRStatus:ocrEnum,
    ocrextractedText:ocrextractedText,
    structuredExtractedData:structuredExtractedData,
    reportDate:reportDate,
    hospitalName:hospitalName,
    doctorName:doctorName,
    remarks:remarks,
  });

module.exports = { DocumentSchema };
