const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../configs/env");
const { UnauthorizedException, InvalidRequestException } = require("../exceptions/appError");
const appleClient = require("../clients/appleClient");

const appleJwksCache = {
  keys: null,
  expiresAt: 0,
};

async function getAppleJwks() {
  const now = Date.now();
  if (appleJwksCache.keys && now < appleJwksCache.expiresAt) {
    return appleJwksCache.keys;
  }

  try {
    const data = await appleClient.fetchPublicKeys();
    if (!data || !Array.isArray(data.keys)) {
      throw new Error("Apple JWKS response did not contain keys array");
    }
    appleJwksCache.keys = data.keys;
    appleJwksCache.expiresAt = now + 24 * 60 * 60 * 1000; // cache for 24 hours
    return appleJwksCache.keys;
  } catch (error) {
    console.error("Failed to fetch Apple public keys:", error);
    throw new UnauthorizedException("Failed to verify Apple token due to keys discovery failure");
  }
}

function findSigningKey(keys, kid) {
  return keys.find((key) => key.kid === kid && key.kty === "RSA");
}

function jwkToPublicKey(jwk) {
  try {
    return crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch (error) {
    console.error("Failed to import Apple JWK key:", error);
    throw new UnauthorizedException("Failed to import Apple public key");
  }
}

function normalizeApplePayload(payload) {
  return {
    sub: payload.sub,
    email: payload.email || null,
    email_verified: payload.email_verified === true || payload.email_verified === "true",
    is_private_email: payload.is_private_email === true || payload.is_private_email === "true",
    rawPayload: payload,
  };
}

async function verifyAppleToken(providerToken) {
  if (!providerToken) {
    throw new InvalidRequestException("Apple identityToken (providerToken) is required");
  }

  const decoded = jwt.decode(providerToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new UnauthorizedException("Invalid Apple token: missing kid in header");
  }

  if (decoded.header.alg !== "RS256") {
    throw new UnauthorizedException(
      `Invalid Apple token algorithm: expected RS256, got ${decoded.header.alg}`,
    );
  }

  const kid = decoded.header.kid;
  let keys = await getAppleJwks();
  let jwk = findSigningKey(keys, kid);

  if (!jwk) {
    // Cache-invalidation retry on unknown kid
    appleJwksCache.keys = null;
    appleJwksCache.expiresAt = 0;
    keys = await getAppleJwks();
    jwk = findSigningKey(keys, kid);
    if (!jwk) {
      throw new UnauthorizedException(
        "Invalid Apple ID Token: key identifier (kid) not found in Apple public keys",
      );
    }
  }

  const publicKey = jwkToPublicKey(jwk);

  let verifiedPayload;
  try {
    verifiedPayload = jwt.verify(providerToken, publicKey, {
      algorithms: ["RS256"],
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw new UnauthorizedException("Apple ID Token has expired");
    }
    console.error("Apple ID Token signature verification failed:", err);
    throw new UnauthorizedException(`Apple ID Token signature verification failed: ${err.message}`);
  }

  // 1. Verify Issuer
  const expectedIssuer = "https://appleid.apple.com";
  if (verifiedPayload.iss !== expectedIssuer) {
    throw new UnauthorizedException(
      `Invalid Apple token issuer: expected ${expectedIssuer}, got ${verifiedPayload.iss}`,
    );
  }

  // 2. Verify Audience
  const rawAudiences = env.appleClientId || "";
  const allowedAudiences = rawAudiences
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (allowedAudiences.length === 0) {
    throw new Error("APPLE_CLIENT_ID is not configured in env");
  }
  if (!allowedAudiences.includes(verifiedPayload.aud)) {
    throw new UnauthorizedException(
      `Audience mismatch for Apple token. Expected one of [${allowedAudiences.join(", ")}], got: ${verifiedPayload.aud}`,
    );
  }

  // 3. Verify Expiration
  const now = Math.floor(Date.now() / 1000);
  if (verifiedPayload.exp < now) {
    throw new UnauthorizedException("Apple ID Token has expired");
  }

  // 4. Verify sub claim
  if (
    !verifiedPayload.sub ||
    typeof verifiedPayload.sub !== "string" ||
    !verifiedPayload.sub.trim()
  ) {
    throw new UnauthorizedException("Invalid Apple token: missing or empty sub claim");
  }

  return normalizeApplePayload(verifiedPayload);
}

module.exports = {
  verifyAppleToken,
  getAppleJwks,
  appleJwksCache,
  normalizeApplePayload,
};
