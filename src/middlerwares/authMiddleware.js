const jwt = require("jsonwebtoken");
const MessageConstants = require("../constant/MessageConstant");

class AuthMiddleware {
  constructor(db) {
    this.db = db;
    this.auth = this.auth.bind(this);
  }
  async auth(req, res, next) {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ message: MessageConstants.TOKEN_NOT_FOUND });
      }
      //decode token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      //get session from db
      const session = await this.db.session.findOne({
        id: decoded.sessionId,
      });

      //vaidate session
      if (!session || !session.isActive || session.logoutTime) {
        return res
          .status(401)
          .json({ message: MessageConstants.SESSION_EXPIRED });
      }
      //  user/session requrest
      req.session = session;
      req.userid = session.userId;
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      return res.status(401).json({ message: MessageConstants.INVALID_TOKEN });
    }
  }
}
module.exports = AuthMiddleware;
