const messageConstant = require("../constant/messageConstant");
const User = require("../models/User");

class userRepository{

    //Login USer
    async loginUser(email){
   const user=await User.findOne({
    where:{ email},
    attributes:['id','userName','email','password']
   }) 
    if(!user) return null;
    return user; 
  }
}
module.exports=new userRepository();