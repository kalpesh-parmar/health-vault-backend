/* global describe, it, expect, afterEach */
const { maskSensitiveData, truncatePayload } = require("../../src/utils/apiLoggerUtil");

describe("apiLoggerUtil - maskSensitiveData", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("should not mask sensitive data in development mode", () => {
    process.env.NODE_ENV = "development";
    const payload = {
      email: "kalpesh.p@techroversolutions.com",
      password: "mySecretPassword123",
      nested: {
        token: "accessTokenVal",
        authorization: "Bearer myToken",
      },
    };

    const result = maskSensitiveData(payload);

    // Development mode should log raw values
    expect(result.password).toBe("mySecretPassword123");
    expect(result.nested.token).toBe("accessTokenVal");
    expect(result.nested.authorization).toBe("Bearer myToken");
    expect(result.email).toBe("kalpesh.p@techroversolutions.com");
  });

  it("should mask sensitive data in production mode", () => {
    process.env.NODE_ENV = "production";
    const payload = {
      email: "kalpesh.p@techroversolutions.com",
      password: "mySecretPassword123",
      nested: {
        token: "accessTokenVal",
        authorization: "Bearer myToken",
      },
    };

    const result = maskSensitiveData(payload);

    // Production mode should mask sensitive keys
    expect(result.password).toBe("***");
    expect(result.nested.token).toBe("***");
    expect(result.nested.authorization).toBe("Bearer ***");
    expect(result.email).toBe("kalpesh.p@techroversolutions.com");
  });

  it("should recursively mask sensitive keys in nested arrays and objects in production", () => {
    process.env.NODE_ENV = "production";
    const payload = {
      patients: [
        {
          name: "John Doe",
          secret: "ssn_code_123",
        },
        {
          name: "Jane Doe",
          secret: "ssn_code_456",
        },
      ],
    };

    const result = maskSensitiveData(payload);

    expect(result.patients[0].secret).toBe("***");
    expect(result.patients[1].secret).toBe("***");
    expect(result.patients[0].name).toBe("John Doe");
    expect(result.patients[1].name).toBe("Jane Doe");
  });

  it("should handle stringified JSON masking in production", () => {
    process.env.NODE_ENV = "production";
    const jsonStr = JSON.stringify({
      password: "plain_password_abc",
      email: "a@b.com",
    });

    const result = maskSensitiveData(jsonStr);
    const parsed = JSON.parse(result);

    expect(parsed.password).toBe("***");
    expect(parsed.email).toBe("a@b.com");
  });
});

describe("apiLoggerUtil - truncatePayload", () => {
  it("should truncate long strings safely", () => {
    const longStr = "a".repeat(1200);
    const result = truncatePayload(longStr, 100);
    expect(result.length).toBeLessThan(1200);
    expect(result).toContain("TRUNCATED");
  });

  it("should handle non-string values cleanly without truncating", () => {
    const payload = { a: 1, b: 2 };
    const result = truncatePayload(payload, 500);
    expect(result).toEqual(payload);
  });
});
