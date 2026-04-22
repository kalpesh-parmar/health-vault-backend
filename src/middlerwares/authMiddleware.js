const jwt = require("jsonwebtoken");
const MessageConstants = require("../constant/MessageConstant");
const {} = require("drizzle-orm");
const { InvalidRequestException } = require("../excptions/ApiError");
const messageConstant = require("../constant/MessageConstant");

class AuthMiddleware {
  constructor(db) {
    this.db = db;
    this.auth = this.auth.bind(this);
  }
  async auth(req, res, next) {
    try {
      const token = req.headers?.authorization.split(" ")[1];
      if (!token) {
        throw InvalidRequestException(messageConstant.INVALID_TOKEN);
      }
      //decode token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // get session from db
      // const session = await this.db.session.findOne({
      //   id: decoded.sessionId,
      // });
      const session = await this.db
        .select()
        .from(this.db.session)
        .where(eq(this.db.session.id, decoded.sessionId))
        .limit(1);

      //vaidate session
      if (!session || !session.isActive || session.logoutTime) {
        throw InvalidRequestException(messageConstant.INVALID_SESSIONID);
      }
      //  user/session requrest
      req.session = session;
      req.userid = session.userId;
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      if (error.name === "TokenExpiredError") {
        try {
          const decoded = jwt.decode(token); // decode without verify

          if (decoded?.sessionId) {
            await this.db
              .update(this.db.session)
              .set({ isActive: false })
              .where(eq(this.db.session.id, decoded.sessionId));
          }
        } catch (dbError) {
          console.error("Session update error:", dbError);
        }
      }
    }
  }
}
module.exports = AuthMiddleware;
