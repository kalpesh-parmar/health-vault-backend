const jwt = require("jsonwebtoken");

const { env } = require("../configs/env");
const { errorConstants } = require("../constants/errorConstants");
const { UnauthorizedException } = require("../exceptions/appError");

function getSecret() {
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }

  return env.jwtSecret;
}

function getBaseOptions() {
  const options = {
    issuer: env.jwtIssuer,
  };

  if (env.jwtAudience) {
    options.audience = env.jwtAudience;
  }

  return options;
}

class JwtUtils {
  static generateAccessToken(payload, options = {}) {
    return jwt.sign(payload, getSecret(), {
      ...getBaseOptions(),
      expiresIn: env.jwtAccessExpiresIn,
      ...options,
    });
  }

  static generateRefreshToken(payload, options = {}) {
    return jwt.sign(
      {
        ...payload,
        tokenType: "refresh",
      },
      getSecret(),
      {
        ...getBaseOptions(),
        expiresIn: env.jwtRefreshExpiresIn,
        ...options,
      },
    );
  }

  static verifyAccessToken(token) {
    try {
      return jwt.verify(token, getSecret(), getBaseOptions());
    } catch {
      throw new UnauthorizedException(errorConstants.INVALID_TOKEN);
    }
  }

  static verifyRefreshToken(token) {
    try {
      const payload = jwt.verify(token, getSecret(), getBaseOptions());

      if (payload.tokenType !== "refresh") {
        throw new UnauthorizedException(errorConstants.INVALID_REFRESH_TOKEN);
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException(errorConstants.INVALID_REFRESH_TOKEN);
    }
  }

  static getBearerToken(authorizationHeader) {
    if (!authorizationHeader) {
      throw new UnauthorizedException(errorConstants.MISSING_AUTH_HEADER);
    }

    const [scheme, token] = authorizationHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException(errorConstants.INVALID_TOKEN);
    }

    return token;
  }
}

module.exports = JwtUtils;
