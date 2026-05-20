require("dotenv").config();
const axios = require("axios");
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
const { ocrStatus } = require("../enums/ocrStatus");
const { updateDocumentSchema } = require("../validations/documentValidation");
const { medicalPrompt, cleanOCRText } = require("../prompt/structureDataPrompt");
// const ollamaService = require("./ollamaService");
const { model } = require("../configs/aiConfig");
const { folderType } = require("../enums/s3Folder");
class DocumentService {
  async createDocument(userId, file, docType) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }

    if (!docType) {
      throw new InvalidRequestException(messageConstants.DOCUMENT_TYPE_IS_REQUIRED);
    }
    const uploadFile = await s3service.uploadFile(file, folderType.DOCUMENT_UPLOAD);
    const fileStoragePath = `https://${process.env.PATIENT_DOCUMENTS_BUCKET}.s3.amazonaws.com/${uploadFile.fileKey}`;

    // upload file using s3 service
    const fileinfo = {
      fileType: file.mimetype,
      fileStoragePath: fileStoragePath,
      fileName: file.originalname,
      fileSize: file.size,
      documentType: docType.documentType,
      s3Bucket: uploadFile.input.Bucket,
      s3Key: uploadFile.fileKey,
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
      fileKey: uploadFile.fileKey,
      bucket: uploadFile.bucket,
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
