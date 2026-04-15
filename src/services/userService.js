require("dotenv").config();
const userRepository=require("../repositories/userRepository")
const messageConstant = require("../constant/messageConstant");
const { InvalidRequestException} = require("../helpers/generalResponse");
class userService{
    async loginUser(data) {
    const {firebaseToken}=data;
    // const decoded = await admin.auth().verifyIdToken(firebaseToken);
    const{id,userName,email}=decoded;
    if(!id||!userName||!email)
        throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    const user = await userRepository.loginUser(email);
    if (!user) {
      throw new InvalidRequestException(messageConstant.INVALID_REQUEST);
    }
    // const token = generateToken({
    //   id: user.id,
    //   email: user.email,
    // });
    const tempToken = jwt.sign(
            { email }, 
            process.env.JWT_SECRET, 
            { expiresIn: '5m' }
        );
     return {
      user,
      tempToken,
    };
}
}``
module.exports=new userService();