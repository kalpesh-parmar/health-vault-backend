require("dotenv").config();
const axios = require("axios");
const { s3Client } = require("../configs/s3");
const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
// const FormData = require("form-data");
require("fs");
const documentRepository = require("../repositories/documentRepository");
const {
  createDocumentSchema,
  idParamSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  validateSchema,
} = require("../validations");
const s3service = require("./s3service");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { ocrStatus } = require("../enums/ocrStatus");
const { updateDocumentSchema } = require("../validations/documentValidation");
const { medicalPrompt, cleanOCRText } = require("../prompt/structureDataPrompt");
// const ollamaService = require("./ollamaService");
const { model } = require("../configs/aiConfig");
class DocumentService {
  async createDocument(userId, file, docType) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }

    if (!docType) {
      throw new InvalidRequestException(messageConstants.DOCUMENT_TYPE_IS_REQUIRED);
    }

    // upload file using s3 service
    const uploadedFile = await s3service.uploadFile(file);
    const fileinfo = {
      fileType: file.mimetype,
      fileStoragePath: uploadedFile.fileStoragePath,
      fileName: file.originalname,
      fileSize: file.size,
      documentType: docType.documentType,
      s3Bucket: uploadedFile.bucket,
      s3Key: uploadedFile.fileKey,
    };

    const validData = await validateSchema(createDocumentSchema, fileinfo);
    const document = await documentRepository.create({
      userId,
      ...validData,
    });
    await documentRepository.update(document.id, {
      ocrStatus: ocrStatus.IN_PROGRESS,
    });

    //ocr API
    const ocrResponse = await axios.post("http://127.0.0.1:8000/run-ocr", {
      fileKey: uploadedFile.fileKey,
      bucket: uploadedFile.bucket,
    });
    const fullText = ocrResponse.data.ocr_text;
    const graph = ocrResponse.data.graphs;
    console.log("fullText===", fullText);
    console.log("graph===", graph);
    // const data={fullText,graph};

    // const cleanText = cleanOCRText(data);
    const prompt = medicalPrompt(fullText, graph);
    console.log(prompt);

    // const structuredData = await ollamaService.generate(prompt);
    const structuredData = await model.generateContent(prompt);
    console.log("structuredData===", structuredData);

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
    console.log("ocrInfo==", ocrInfo);

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

  async listDocuments(payload) {
    const data = await validateSchema(listDocumentsFilterSortSchema, payload || {});
    return documentRepository.findAllByFilterAndSort(data);
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
    const signedUrl = await s3service.generateSignedUrl(fileKey);

    return {
      downloadUrl: signedUrl,
    };
  }

  //delete document from s3 bucket using file key
  async deleteFile(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }

    const command = new DeleteObjectCommand({
      Bucket: process.env.PATIENT_DOCUMENTS_BUCKET,
      Key: fileKey,
    });
    await s3Client.send(command);
    return { message: messageConstants.DOCUMENT_DELETED };
  }
}

module.exports = new DocumentService();
