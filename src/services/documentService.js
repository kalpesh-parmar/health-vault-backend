require("dotenv").config();
const axios = require("axios");
const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
require("fs");
const documentRepository = require("../repositories/documentRepository");
const {
  idParamSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  validateSchema,
} = require("../validations");
const s3service = require("./s3service");
const { ocrStatus } = require("../enums/ocrStatus");
const { updateDocumentSchema, createDocumentSchema } = require("../validations/documentValidation");
const { medicalPrompt, cleanOCRText } = require("../prompt/structureDataPrompt");
const { model } = require("../configs/aiConfig");
class DocumentService {
  async createDocument(userId, payload) {
    const validData = await validateSchema(createDocumentSchema, payload);
    const insertData = {
      userId: userId,
      documentType: validData.documentType,
      fileName: validData.fileName,
      fileSize: validData.fileSize,
      filePath: validData.filePath,
      fileType: validData.fileType,
      s3Bucket: validData.s3Bucket,
      s3Key: validData.s3Key,
    };

    const document = await documentRepository.create(insertData);
    await documentRepository.update(document.id, {
      ocrStatus: ocrStatus.IN_PROGRESS,
    });

    //ocr API
    const ocrResponse = await axios.post("http://127.0.0.1:8000/run-ocr", {
      fileKey: validData.s3Key,
      bucket: validData.s3Bucket,
    });
    const fullText = ocrResponse.data.ocr_text;
    const graph = ocrResponse.data.graphs;

    const prompt = medicalPrompt(fullText, graph);

    const structuredData = await model.generateContent(prompt);

    const responseText = structuredData.response.text();
    const cleanData = cleanOCRText(responseText);
    const jsonData = JSON.parse(cleanData);

    const ocrInfo = {
      ocrExtractedText: ocrResponse.data,
      structuredExtractedData: jsonData,
      hospitalName: jsonData.hospital?.name,
      doctorName: jsonData.doctor?.name,
      reportDate: jsonData.report?.reportDate,
      remarks: jsonData.remarks,
      ocrStatus: ocrStatus.COMPLETED,
    };
    const validOcr = await validateSchema(updateDocumentSchema, ocrInfo);

    return documentRepository.update(document.id, {
      ...validOcr,
    });
  }

  async getDocumentById(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const existingDocument = await documentRepository.findById(params.id);

    if (!existingDocument || existingDocument.userId !== userId) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }
    return existingDocument;
  }

  async getDocumentList(userId, payload) {
    const filters = await validateSchema(listDocumentsQuerySchema, payload);

    const { rows, total } = await documentRepository.findAll({
      ...filters,
      userId,
    });

    return {
      items: rows,
      limit: filters.limit,
      page: filters.page,
      total,
    };
  }

  async listDocuments(userId, payload) {
    const data = await validateSchema(listDocumentsFilterSortSchema, payload || {});
    return documentRepository.findAllByFilterAndSort({
      userId,
      ...data,
    });
  }

  async listDocumentsPaginated(userId, payload) {
    if (!userId) {
      throw new InvalidRequestException(errorConstants.USER_NOT_FOUND);
    }
    const data = await validateSchema(listDocumentsPaginatedSchema, payload);
    const result = await documentRepository.findAllByFilterSortAndPagination({
      ...data,
      userId,
    });
    return {
      items: result.data,
      page: result.page,
    };
  }

  async deleteDocument(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const deletedDocument = await documentRepository.softDeleteById(params.id, userId);

    if (!deletedDocument) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }

    return deletedDocument;
  }

  // download document from s3 bucket using file key
  async getDownloadUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }

    // use s3 service here
    const url = await s3service.getSignedFileUrl(fileKey);
    return {
      signedUrl: url,
    };
  }

  //delete document from s3 bucket using file key
  async deleteFile(userId, fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    await s3service.deleteFile(fileKey);
    await documentRepository.deleteByPatientId(userId);
    return { message: messageConstants.DOCUMENT_DELETED };
  }
}

module.exports = new DocumentService();
