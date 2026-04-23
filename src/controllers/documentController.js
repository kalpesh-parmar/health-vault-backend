const messageConstant = require("../constant/messageConstant");
const errorHandler = require("../excptions/globalHandling");
const GeneralResponse = require("../helpers/genralResponse");
const documentService = require("../services/documentService");
const zodValidateData=require("../validation/index");
const{  documentSchema } = require("../validation/zodDocumentValidation");

class documentController {
  // Add Document
  addDocument = async (req, res, next) => {
    try {
      const result = await documentService.createDocument(req?.body);
      return GeneralResponse.created(
        res,
        result,
        messageConstant.DOCUMENT_ADDED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in addDocument:", error);
      next(error);
    }
  };

  // Get Document by ID
  getDocumentById = async (req, res, next) => {
    try {
      const result = await documentService.getDocumentById(req?.params?.id);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.DOCUMENT_FETCHED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in getDocumentById:", error);
      next(error);
    }
  };

  // Get Document List
  getDocumentList = async (req, res, next) => {
    try {
      const result = await documentService.getDocumentList();
      return GeneralResponse.success(
        res,
        result,
        messageConstant.DOCUMENT_LIST_FETCHED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in getDocumentList:", error);
      next(error);
    }
  };

  // Delete Document
  deleteDocument = async (req, res, next) => {
    try {
      const result = await documentService.deleteDocument(req?.params?.id);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.DOCUMENT_DELETED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in deleteDocument:", error);
      next(error);
    }
  };
}
module.exports = new documentController();
