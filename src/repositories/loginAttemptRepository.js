const { eq, and } = require("drizzle-orm");
const { db } = require("../configs/db");
const { loginAttempt } = require("../models/loginAttempts");

class LoginAttemptRepository {
  async findAttempt(identifier, provider, loginType) {
    const result = await db
      .select()
      .from(loginAttempt)
      .where(
        and(
          eq(loginAttempt.identifier, identifier),
          eq(loginAttempt.provider, provider),
          eq(loginAttempt.loginType, loginType),
          eq(loginAttempt.softDelete, false),
        ),
      )
      .limit(1);

    return result[0] || null;
  }

  async incrementFailedAttempt(identifier, provider, loginType) {
    const existing = await this.findAttempt(identifier, provider, loginType);

    if (existing) {
      let newFailedAttempts = existing.failedAttempts + 1;
      let newBlockedUntil = existing.blockedUntil;

      if (existing.blockedUntil && new Date() > new Date(existing.blockedUntil)) {
        console.log(
          `[AUTH LOG] 15-min block expired for ${identifier}. Starting fresh with 1 failed attempt.`,
        );
        newFailedAttempts = 1;
        newBlockedUntil = null;
      }

      const result = await db
        .update(loginAttempt)
        .set({
          failedAttempts: newFailedAttempts,
          blockedUntil: newBlockedUntil,
          lastAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(loginAttempt.id, existing.id))
        .returning();

      return result[0];
    }

    const result = await db
      .insert(loginAttempt)
      .values({
        identifier,
        provider,
        loginType,
        failedAttempts: 1,
        lastAttemptAt: new Date(),
      })
      .returning();

    return result[0];
  }

  async blockMethod(id, blockUntil) {
    const result = await db
      .update(loginAttempt)
      .set({
        blockedUntil: blockUntil,
        updatedAt: new Date(),
      })
      .where(eq(loginAttempt.id, id))
      .returning();
    return result[0];
  }

  async resetAttempts(identifier, provider, loginType) {
    const existing = await this.findAttempt(identifier, provider, loginType);

    if (existing && (existing.failedAttempts > 0 || existing.blockedUntil)) {
      console.log(
        `[AUTH LOG] Successful login for ${identifier}. Wiping old failures (was ${existing.failedAttempts}). Resetting failedAttempts to 0.`,
      );
      await db
        .update(loginAttempt)
        .set({
          failedAttempts: 0,
          blockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(loginAttempt.id, existing.id));
    }
  }

  async createAttempt(data) {
    const result = await db.insert(loginAttempt).values(data).returning();

    return result[0];
  }

  async updateAttempt(id, data) {
    const result = await db
      .update(loginAttempt)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(loginAttempt.id, id))
      .returning();

    return result[0];
  }
}

module.exports = new LoginAttemptRepository();
