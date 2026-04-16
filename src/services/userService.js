require("dotenv").config();
const bcrypt = require("bcrypt");
const { userSchema } = require("../validation/zodValidation");
const { session: sessionTable } = require("../models/session");
const { user } = require("../models/User");
const { db } = require("../config/db");
const { GeneralResponse } = require("../helpers/genralResponse");
const userRepository = require("../repositories/userRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");

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
    return {
      tempToken,
    };
  }

  //getUserById
  async  getUserById(id) {
    try {
      if(!id)
        throw new GeneralResponse.notFound(
      messageConstant.USER_NOT_FOUND
    );
      const user = await userRepository.getUserById(id);
      console.log(user);
      
      return user;
    } catch (error) {
      throw error
    }

    }
}

module.exports = new userService();
