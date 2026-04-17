require("dotenv").config();
const bcrypt = require("bcrypt");
const { userSchema, updateUserSchema } = require("../validation/zodValidation");
const { session: sessionTable } = require("../models/session");
const { user } = require("../models/User");
const { db } = require("../config/db");
const { GeneralResponse } = require("../helpers/genralResponse");
const userRepository = require("../repositories/userRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");
const {
  InvalidRequestException,
  NotFoundException,
} = require("../excptions/ApiError");

class userService {
  // Create User
  async createUser(data) {
    const result = userSchema.safeParse(data);

    console.log(data);
    if (!result.success) {
      throw result.error;
    }
    const validatedData = result.data;
    validatedData.password = await bcrypt.hash(validatedData.password, 10);
    const newUser = await userRepository.createUser(validatedData);
    return newUser;
  }

  //Login User
  async loginUser(data) {
    const { email, password } = data;
    const userData = await userRepository.loginUser(email);
    if (!userData) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }

    //Sessiondata
    const session = await userRepository.createSession({ userId: userData.id });
    const tempToken = jwt.sign(
      { sessionId: session.id },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );
    return tempToken;
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
    const result = updateUserSchema.safeParse(data);
    if (!result.success) {
      throw result.error;
    }
    const validatedData = result.data;
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
