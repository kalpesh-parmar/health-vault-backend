const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
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
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
class DocumentService {
  async createDocument(userId, file, docType) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!docType) {
      throw new InvalidRequestException(messageConstants.DOCUMENT_TYPE_IS_REQUIRED);
    }
    const fileKey = `uploads/${Date.now()}-${file.originalname}`;
    const filedata = new PutObjectCommand({
      Bucket: process.env.PATIENT_DOCUMENTS_BUCKET,
      Key: fileKey,
      Body: file.buffer,
    });

    const fileStoragePath = `https://${process.env.PATIENT_DOCUMENTS_BUCKET}.s3.amazonaws.com/${fileKey}`;

    await s3Client.send(filedata);

    const fileinfo = {
      fileType: file.mimetype,
      fileStoragePath,
      fileName: file.originalname,
      fileSize: file.size,
      documentType: docType.documentType,
      s3Bucket: filedata.input.Bucket,
      s3Key: filedata.input.Key,
    };

    const validData = await validateSchema(createDocumentSchema, fileinfo);
    return documentRepository.create({
      userId,
      ...validData,
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

  // download document from s3 bucket using file key
  async getDownloadUrl(fileKey, fileName = "document") {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }

    const command = new GetObjectCommand({
      Bucket: process.env.PATIENT_DOCUMENTS_BUCKET,
      Key: fileKey,

      // force browser to download file
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
    });

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: 600, // 10 minutes
    });

    return url;
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
