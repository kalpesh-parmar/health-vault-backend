const axios = require("axios");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../configs/env");
const { UnauthorizedException, InvalidRequestException } = require("../exceptions/appError");

const microsoftJwksCache = {
  keys: null,
  expiresAt: 0,
};

async function fetchMicrosoftOpenIdConfig(tenant) {
  const openIdConfigUrl = `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
  const { data } = await axios.get(openIdConfigUrl, { timeout: 5000 });
  if (!data?.jwks_uri) {
    throw new Error("Microsoft OpenID configuration did not return jwks_uri");
  }
  return data;
}

async function getMicrosoftJwks(tenant) {
  const now = Date.now();
  if (microsoftJwksCache.keys && now < microsoftJwksCache.expiresAt) {
    return microsoftJwksCache.keys;
  }

  const openIdConfig = await fetchMicrosoftOpenIdConfig(tenant);
  const { data } = await axios.get(openIdConfig.jwks_uri, { timeout: 5000 });
  microsoftJwksCache.keys = data.keys;
  microsoftJwksCache.expiresAt = now + 60 * 60 * 1000;
  return microsoftJwksCache.keys;
}

function findSigningKey(jwks, kid) {
  return jwks.find((key) => key.kid === kid && key.kty === "RSA");
}

function jwkToPem(jwk) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return publicKey.export({ type: "spki", format: "pem" });
}

function normalizeMicrosoftPayload(payload) {
  const name = payload.name || "";
  const [firstName, ...rest] = name.split(" ");

  return {
    id:
      payload.oid ||
      payload.sub ||
      payload.unique_name ||
      payload.email ||
      payload.preferred_username,
    email: payload.email || payload.preferred_username || payload.upn,
    given_name: payload.given_name || firstName || "User",
    family_name: payload.family_name || rest.join(" ") || "",
  };
}

async function verifyToken(providerToken) {
  if (!providerToken) {
    throw new InvalidRequestException("Microsoft token is required");
  }

  if (!env.microsoftClientId) {
    throw new Error("MICROSOFT_CLIENT_ID is required for Microsoft login flow");
  }

  const decoded = jwt.decode(providerToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new UnauthorizedException("Invalid Microsoft token");
  }

  const tenant = env.microsoftTenantId || "common";
  const jwks = await getMicrosoftJwks(tenant);
  const signingKey = findSigningKey(jwks, decoded.header.kid);
  if (!signingKey) {
    throw new UnauthorizedException("Microsoft signing key not found");
  }

  const publicKey = jwkToPem(signingKey);
  let verified;
  try {
    verified = jwt.verify(providerToken, publicKey, {
      audience: env.microsoftClientId,
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      algorithms: ["RS256"],
    });
  } catch (error) {
    console.error(error);
    throw new UnauthorizedException("Invalid Microsoft token");
  }

  return normalizeMicrosoftPayload(verified);
}

module.exports = {
  verifyToken,
};
