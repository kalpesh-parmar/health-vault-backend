const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../../src/configs/env");
const appleClient = require("../../src/clients/appleClient");
const { verifyAppleToken, appleJwksCache } = require("../../src/utils/appleUtils");

describe("appleUtils Unit Tests", () => {
  let privateKeyPem;
  let publicKeyJwk;
  const kid = "test-apple-kid-1";

  beforeAll(() => {
    // Generate an RSA keypair for testing
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const jwk = publicKey.export({ format: "jwk" });
    publicKeyJwk = {
      ...jwk,
      kid,
      kty: "RSA",
      use: "sig",
      alg: "RS256",
    };
  });

  beforeEach(() => {
    // Reset cache before each test
    appleJwksCache.keys = [publicKeyJwk];
    appleJwksCache.expiresAt = Date.now() + 100000;
    jest.clearAllMocks();
  });

  test("should successfully verify a valid Apple RS256 token and return normalized payload", async () => {
    const audience = env.appleClientId || "com.anonymous.DocumentsVaultApp";
    const payload = {
      iss: "https://appleid.apple.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub: "001234.test.apple.sub",
      email: "user@privaterelay.appleid.com",
      email_verified: "true",
      is_private_email: "true",
    };

    const token = jwt.sign(payload, privateKeyPem, {
      algorithm: "RS256",
      keyid: kid,
    });

    const result = await verifyAppleToken(token);
    expect(result.sub).toBe("001234.test.apple.sub");
    expect(result.email).toBe("user@privaterelay.appleid.com");
    expect(result.email_verified).toBe(true);
    expect(result.is_private_email).toBe(true);
  });

  test("should reject token if missing providerToken", async () => {
    await expect(verifyAppleToken("")).rejects.toThrow(
      "Apple identityToken (providerToken) is required",
    );
  });

  test("should reject token if header missing kid", async () => {
    const token = jwt.sign({ sub: "123" }, "secret");
    await expect(verifyAppleToken(token)).rejects.toThrow(
      "Invalid Apple token: missing kid in header",
    );
  });

  test("should reject token if algorithm is not RS256", async () => {
    const token = jwt.sign({ sub: "123" }, "secret", {
      algorithm: "HS256",
      keyid: "some-kid",
    });
    await expect(verifyAppleToken(token)).rejects.toThrow(
      "Invalid Apple token algorithm: expected RS256",
    );
  });

  test("should reject token if expired", async () => {
    const audience = env.appleClientId || "com.anonymous.DocumentsVaultApp";
    const payload = {
      iss: "https://appleid.apple.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
      sub: "001234.test.apple.sub",
    };

    const token = jwt.sign(payload, privateKeyPem, {
      algorithm: "RS256",
      keyid: kid,
    });

    await expect(verifyAppleToken(token)).rejects.toThrow("Apple ID Token has expired");
  });

  test("should reject token if issuer is invalid", async () => {
    const audience = env.appleClientId || "com.anonymous.DocumentsVaultApp";
    const payload = {
      iss: "https://invalid-issuer.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "001234.test.apple.sub",
    };

    const token = jwt.sign(payload, privateKeyPem, {
      algorithm: "RS256",
      keyid: kid,
    });

    await expect(verifyAppleToken(token)).rejects.toThrow("Invalid Apple token issuer");
  });

  test("should reject token if audience does not match", async () => {
    const payload = {
      iss: "https://appleid.apple.com",
      aud: "wrong.app.bundle.id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "001234.test.apple.sub",
    };

    const token = jwt.sign(payload, privateKeyPem, {
      algorithm: "RS256",
      keyid: kid,
    });

    await expect(verifyAppleToken(token)).rejects.toThrow("Audience mismatch for Apple token");
  });

  test("should reject token if sub is missing or empty", async () => {
    const audience = env.appleClientId || "com.anonymous.DocumentsVaultApp";
    const payload = {
      iss: "https://appleid.apple.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "",
    };

    const token = jwt.sign(payload, privateKeyPem, {
      algorithm: "RS256",
      keyid: kid,
    });

    await expect(verifyAppleToken(token)).rejects.toThrow(
      "Invalid Apple token: missing or empty sub claim",
    );
  });

  test("should refresh keys on unknown kid and succeed if new key matches", async () => {
    const newKid = "test-apple-kid-2";
    const { privateKey: newPrivKey, publicKey: newPubKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const newPrivPem = newPrivKey.export({ type: "pkcs8", format: "pem" });
    const newJwk = {
      ...newPubKey.export({ format: "jwk" }),
      kid: newKid,
      kty: "RSA",
      use: "sig",
      alg: "RS256",
    };

    // Spy on appleClient.fetchPublicKeys to return the new key
    jest.spyOn(appleClient, "fetchPublicKeys").mockResolvedValueOnce({
      keys: [publicKeyJwk, newJwk],
    });

    const audience = env.appleClientId || "com.anonymous.DocumentsVaultApp";
    const payload = {
      iss: "https://appleid.apple.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "005678.refreshed.kid.sub",
    };

    const token = jwt.sign(payload, newPrivPem, {
      algorithm: "RS256",
      keyid: newKid,
    });

    const result = await verifyAppleToken(token);
    expect(result.sub).toBe("005678.refreshed.kid.sub");
    expect(appleClient.fetchPublicKeys).toHaveBeenCalledTimes(1);
  });
});
