const messageConstant = require("../constant/messageConstant");
const { getOkResponse, getCreatedResponse, getGeneralResponse } = require("../helpers/generalResponse");
const userService=require("../services/userService")

class userController {
    loginUser = async (req,res,next) => {
        try {
            const result=await userService.loginUser(req.body);
            const meta=getCreatedResponse(messageConstant.LOGIN_SUCCESSFULLY)
            return getGeneralResponse(res, meta, result);
        } catch (error) {
            console.log("error in login user:",error);
            next(error);
        };
    }
    createUser = async(req,res,next)=>{
        try{
            const result = await userService.createUser(req.body);
            const meta=getCreatedResponse(messageConstant.USER_ADDED_SUCCESSFULLY)
            return getGeneralResponse(res,meta,result);
        }catch(error){
            console.log("error in create user:",error);
            next(error);            
        }
    }
}
module.exports = new userController();