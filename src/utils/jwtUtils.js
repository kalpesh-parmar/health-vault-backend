const jwt = require("jsonwebtoken");
const { InvalidRequestException } = require("../excptions/ApiError");
const messageConstant = require("../constant/MessageConstant");
require("dotenv").config();

const SECRET_KEY=process.env.JWT_SECRET;
const EXPIREIN="7d";

const tempToken =(payload)=>{ return jwt.sign(
        payload,
      SECRET_KEY,
        {expiresIn:EXPIREIN,}
    )};

const validateToken=(tempToken)=>{
    return jwt.verify(tempToken,SECRET_KEY);
    if(!validateToken)
        throw InvalidRequestException(messageConstant.INVALID_TOKEN);
}

module.exports={tempToken,validateToken};