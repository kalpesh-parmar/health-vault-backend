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
const { User } = require("../models/User");
const { db } = require("../config/db");
const { GeneralResponse } = require("../helpers/genralResponse");
const userRepository = require("../repositories/userRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");
const zodValidateData = require("../validation/index");
const { generateNumericPatientCode } = require("../utils/generateCode");
const { tempToken } = require("../utils/jwtUtils");
const JwtUtils = require("../utils/jwtUtils");

class userService {
  //Login User
  async loginUser(data) {
    const { email, password } = data;
    if (!email || !password) {
      throw new InvalidRequestException(
        messageConstant.EMAIL_PASSWORD_REQUIRED,
      );
    }
    const validation = await zodValidateData(loginUserSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException("Validation failed", validation.error);
    }
    const userData = await userRepository.loginUser(email);
    console.log("userData====", userData);

    if (!userData) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    //Sessiondata
    const session = await userRepository.createSession({ userId: userData.id });
    console.log("session====", session);
    const payload = { session: session.id };
    return JwtUtils.generateToken(payload);
  }

  // Create User
  async createUser(data) {
    data.patientCode = generateNumericPatientCode();
    const validation = await zodValidateData(userSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException("Validation failed", validation.error);
    }
    const validatedData = validation.data || {};
    const existingUser = await userRepository.findUserByEmail(
      validatedData.email,
    );

    if (existingUser) {
      throw new InvalidRequestException(messageConstant.EMAIL_ALREADY_EXISTS);
    }
    validatedData.password = await bcrypt.hash(validatedData.password, 10);
    const newUser = await userRepository.createUser(validatedData);
    return newUser;
  }
  //get user by id
  async getUserById(id) {
    if (!id) throw InvalidRequestException(messageConstant.USER_NOT_FOUND);
    return await userRepository.getUserById(id);
    if (!result) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
  }

  //get user list
  async getUserList() {
    return await userRepository.getUserList();
  }

  //update user by one filed
  async updateUser(id, data) {
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
    const updatedUser = await userRepository.updateUser(id, validatedData);
    return updatedUser;
  }

  //delete user by id
  async deleteUser(id) {
    {
      if (!id) {
        throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
      }
      const result = await userRepository.deleteUser(id);
      if (!result) {
        throw new NotFoundException(messageConstant.USER_NOT_FOUND);
      }
    }
  }
}

module.exports = new userService();
