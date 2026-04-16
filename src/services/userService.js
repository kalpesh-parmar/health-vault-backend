require("dotenv").config();
const bcrypt = require("bcrypt");
const { userSchema } = require("../validation/zodValidation");
const userRepository = require("../repositories/userRepository");
const messageConstant = require("../constant/messageConstant");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

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
    const { firebaseToken } = data;
    // const decoded = await admin.auth().verifyIdToken(firebaseToken);
    const { id, userName, email } = data;
    const user = await userRepository.loginUser(email);
    if (!user) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    // const token = generateToken({
    //   id: user.id,
    //   email: user.email,
    // });
    const sessionId = uuidv4();

    const tempToken = jwt.sign({ email, sessionId }, process.env.JWT_SECRET, {
      expiresIn: "5m",
    });
    return {
      tempToken,
      sessionId
    };
  }
}

module.exports = new userService();
