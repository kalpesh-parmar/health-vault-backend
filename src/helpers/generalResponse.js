const messageConstant = require("../constant/messageConstant");

class Response {
  constructor(code, status, description) {
    this.code = code;
    this.status = status;
    this.description = description;
  }
}

function getGeneralResponse(res, meta, data = null) {
  return res.status(meta.code).json({
    generalMessage:{
    status: meta.status,
    code: meta.code,
    description: meta.description,
  },
    data: data,
  });
}

function getErrorResponse(res,meta){
  return res.status(meta.code).json({
    status:meta.status,
    code:meta.code,
    description:meta.description
  })
}

function getNotFoundResponse(message = messageConstant.NO_DATA_FOUND) {
  return new Response(404, messageConstant.ERROR, message);
}

function getOkResponse(message) {
  return new Response(200, messageConstant.OK, message);
}

function getCreatedResponse(message) {
  return new Response(200, messageConstant.CREATED, message);
}

function getUpdatedResponse(message) {
  return new Response(200, messageConstant.UPDATED, message);
}

function getDeletedResponse(message) {
  return new Response(200, messageConstant.DELETED, message);
}

function getInvalidRequestResponse(message) {
  return new Response(400, messageConstant.ERROR, message);
}

function getUnauthorizeResponse(message) {
  return new Response(401, messageConstant.ERROR, message);
}

function getInternalServerErrorResponse() {
  return new Response(
    500,
    messageConstant.ERROR,
    messageConstant.SOMETHING_WENT_WRONG,
  );
}

module.exports = {
  Response,
  getNotFoundResponse,
  getErrorResponse,
  getGeneralResponse,
  getOkResponse,
  getCreatedResponse,
  getUpdatedResponse,
  getDeletedResponse,
  getInvalidRequestResponse,
  getUnauthorizeResponse,
  getInternalServerErrorResponse,
};
