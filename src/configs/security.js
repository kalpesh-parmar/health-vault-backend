const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const { errorConstants } = require("../constants/errorConstants");
const { env } = require("./env");

const helmetMiddleware = helmet();

const apiRateLimiter = rateLimit({
  legacyHeaders: false,
  limit: env.rateLimitMax,
  message: {
    details: null,
    errorCode: "RATE_LIMIT_EXCEEDED",
    message: errorConstants.RATE_LIMIT_EXCEEDED,
    success: false,
  },
  standardHeaders: true,
  windowMs: env.rateLimitWindowMs,
});

module.exports = {
  apiRateLimiter,
  helmetMiddleware,
};
