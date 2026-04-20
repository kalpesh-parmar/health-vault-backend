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
} = require("../validation/zodValidation");
const { session: sessionTable } = require("../models/session");
const { user } = require("../models/User");
const { db } = require("../config/db");
const { GeneralResponse } = require("../helpers/genralResponse");
const userRepository = require("../repositories/userRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");
const zodValidateData = require("../validation");

class userService {
  //Login User
  async loginUser(data) {
    const { email, password } = data;
    if (!email || !password) {
      throw new InvalidRequestException(
        messageConstant.EMAIL_PASSWORD_REQUIRED,
      );
    }
    const userData = await userRepository.loginUser(email);
    if (!userData) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    //Sessiondata
    const session = await userRepository.createSession({ userId: userData.id });
    const tempToken = jwt.sign(
      {
        sessionId: session.id,
        userId: userData.id,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );
    return tempToken;
  }

  // Create User
  async createUser(data) {
    const validation = await zodValidateData(userSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException(validation.error);
    }
    const validatedData = validation.data;
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
    if (!data || Object.keys(data).length === 0) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }

    const validation = await zodValidateData(updateUserSchema, data);
    if (!validation.success) {
      throw new InvalidRequestException(validation.error);
    }
    const validatedData = validation.data;
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
