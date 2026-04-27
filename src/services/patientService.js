require("dotenv").config();
const bcrypt = require("bcrypt");
const {
  InvalidRequestException,
  NotFoundException,
  AlredayExistsException,
  UnauthorizedException,
  AccessDeniedError,
} = require("../excptions/ApiError");
const {
  userSchema,
  updateUserSchema,
  loginUserSchema,
} = require("../validation/zodUserValidation");
const { session } = require("../models/session");
const { User } = require("../models/patient");
const { db } = require("../config/db");
const { GeneralResponse } = require("../helpers/genralResponse");
const patientRepository = require("../repositories/patientRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");
const zodValidateData = require("../validation/index");
const { generateNumericPatientCode } = require("../utils/generateCode");
const { tempToken } = require("../utils/jwtUtils");
const JwtUtils = require("../utils/jwtUtils");
const sessionRepositoty = require("../repositories/sessionRepository");
const documentRepository = require("../repositories/doucumentRepository");
const healthRecordsRepository = require("../repositories/healthRecordsRepository");
const sessionRepository = require("../repositories/sessionRepository");
class patientService {
  //Login Patient
  async loginPatient(data) {
    const validation = await zodValidateData(loginUserSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException("Validation failed", validation.error);
    }
    const userData = await patientRepository.loginPatient(validation.data.email,validation.data.password);
    if (!userData) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    const isMatch = await bcrypt.compare(validation.data.password, userData.password);
    if (!isMatch) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    //Sessiondata
    const session = await sessionRepositoty.createSession({ userId: userData.id });
    const payload = { session: session.id };
    return JwtUtils.generateToken(payload);
  }

  // Create Patient
  async createPatient(data) {
    const patientCode = await generateNumericPatientCode();
    const userData = { ...data, patientCode };
    const validation = await zodValidateData(userSchema, userData);
    if (!validation.success) {
      throw new InvalidRequestException("Validation failed", validation.error);
    }
    const validatedData = validation.data || {};
    const existingUser = await patientRepository.findPatientByEmail(
      validatedData.email,
    );
    if (existingUser) {
      throw new InvalidRequestException(messageConstant.EMAIL_ALREADY_EXISTS);
    }
    validatedData.password = await bcrypt.hash(validatedData.password, 10);
    const newUser = await patientRepository.createPatient(validatedData);
    return newUser;
  }
  //get patient by id
  async getPatientById(id) {
    if (!id) {
      throw new InvalidRequestException(messageConstant.USER_NOT_FOUND);
    }
    return await patientRepository.getPatientById(id);
    if (!result) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    return result;
  }

  //get patient list
  async getPatientList() {
    return await patientRepository.getPatientList();
  }

  //update patient by one filed
  async updatePatient(id, data) {
    if (!id) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    const validation = await zodValidateData(updateUserSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException("Validation failed", validation.error);
    }
    const validatedData = validation.data || {};
    if (validatedData.password) {
      validatedData.password = await bcrypt.hash(validatedData.password, 10);
    }
    const updatedUser = await patientRepository.updatePatient(id, validatedData);
    return updatedUser;
  }

  //delete patient by id
  async deletePatient(id) {
      if (!id) {
        throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
      }
      const result = await patientRepository.deletePatient(id);
      if (!result) {
        throw new NotFoundException(messageConstant.USER_NOT_FOUND);
      }
    }

  //permanent delete patient by id
  async permanentDeletePatient(id) {
    if (!id) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    await sessionRepositoty.deleteSessionsByUserId(id);
    await documentRepository.permanentDeleteDocument(id);
    await healthRecordsRepository.permanentDeleteHealthRecord(id);
    const result = await patientRepository.permanentDeletePatient(id);
    return result;
  }

  // logout user
  async logout(token) {
    if (!token) {
      throw new InvalidRequestException(messageConstant.INVALID_TOKEN); 
    }
    const decoded = JwtUtils.checkValidateToken(token);
    const sessionId=decoded.session;
    console.log(sessionId);
    
    const existing = await sessionRepository.findById(sessionId);
    if (!existing) {
      throw new InvalidRequestException(messageConstant.SESSION_NOT_FOUND);
    }
    const result = await sessionRepository.logout(sessionId);
    return result;
  }
}

module.exports = new patientService();
