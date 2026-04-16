const messageConstant = require("../constant/messageConstant");
const GeneralResponse  = require("../helpers/genralResponse");
const userService=require("../services/userService")

class userController {
    loginUser = async (req,res,next) => {
        try {
            const result=await userService.loginUser(req.body);
            return GeneralResponse.success(
                res,
                messageConstant.USER_LOGIN_SUCCESSFULLY,
                result
            );
        } catch (error) {
            console.log("error in login user:",error);
            next(error);
        };
    }
    createUser = async(req,res,next)=>{
        try{
            const result = await userService.createUser(req.body);
            return GeneralResponse.created(
                res,
                messageConstant.USER_ADDED_SUCCESSFULLY,
                result
            );
        }catch(error){
            console.log("error in create user:",error);
            next(error);            
        }
    }
    getUserById =async (req , res, next) => {
        try {
            const result=await userService.getUserById(req.params.id);
            return GeneralResponse.success(
                res,
                messageConstant.USER_FOUND_SUCCESSFULLY,
                result
            )
        } catch (error) {
            console.log("error in getUserById:",error);
            next(error);
        }
    }
}
module.exports = new userController();