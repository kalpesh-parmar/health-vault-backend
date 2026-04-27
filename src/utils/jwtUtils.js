const jwt = require("jsonwebtoken");
const { InvalidRequestException } = require("../excptions/ApiError");
const messageConstant = require("../constant/MessageConstant");
require("dotenv").config();

const SECRET_KEY = process.env.JWT_SECRET;
const EXPIREIN = "7d";

module.exports = class JwtUtils {
  static generateToken = (payload) => {
    console.log("payload in generateToken:", payload);
    return jwt.sign(payload, SECRET_KEY, { expiresIn: EXPIREIN });
  };

  static checkValidateToken = (token) => {
    return jwt.verify(token, SECRET_KEY);
  };

  static checkExpireToken = (token) => {};
};
