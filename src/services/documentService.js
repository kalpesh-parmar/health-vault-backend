require("dotenv").config();
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
const s3service = require("./s3service");
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

    const fileinfo = {
      fileType: file.mimetype,
      fileStoragePath,
      fileName: file.originalname,
      fileSize: file.size,
      documentType: docType.documentType,
      s3Bucket: uploadFile.input.Bucket,
      s3Key: uploadFile.fileKey,
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
  async getDownloadUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
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
