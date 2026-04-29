const { PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();
const { s3Client } = require("../configs/s3");
const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const {
  createDocumentSchema,
  idParamSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  validateSchema,
} = require("../validations");

class DocumentService {
  async createDocument(userId, file, docType) {
    console.log(userId);
    console.log(docType.documentType);
    console.log(file);

    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!docType) {
      throw new InvalidRequestException(messageConstants.DOCUMENT_TYPE_IS_REQUIRED);
    }
    const fileKey = `${this.folder}/${Date.now()}-${file.originalname}`;
    const filedata = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: fileKey,
      Body: file.buffer,
    });
    const fileinfo = {
      ContentType: file.mimetype,
      fileName: file.originalname,
      fileSize: file.size,
      documentType: docType.documentType,
    };
    console.log(fileinfo);
    await s3Client.send(filedata);
    const validData = await validateSchema(createDocumentSchema, fileinfo);
    console.log("validData", validData);

    return documentRepository.create({
      fileKey,
      userId,
      validData,
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

  async listDocumentsPaginated(payload) {
    const data = await validateSchema(listDocumentsPaginatedSchema, payload);
    return documentRepository.findAllByFilterSortAndPagination(data);
  }

  async deleteDocument(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const deletedDocument = await documentRepository.softDeleteById(params.id, userId);

    if (!deletedDocument) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }

    return deletedDocument;
  }
}

module.exports = new DocumentService();
