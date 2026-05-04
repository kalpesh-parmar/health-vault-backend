const { and, eq, gt } = require("drizzle-orm");

const { db } = require("../configs/db");
const { session } = require("../models/session");

class SessionRepository {
  async create(data) {
    const result = await db.insert(session).values(data).returning();
    return result[0] || null;
  }

  async findById(id) {
    const result = await db
      .select()
      .from(session)
      .where(and(eq(session.id, id), eq(session.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async findActiveById(id) {
    const result = await db
      .select()
      .from(session)
      .where(
        and(
          eq(session.id, id),
          eq(session.isActive, true),
          eq(session.softDelete, false),
          gt(session.refreshTokenExpiresAt, new Date()),
        ),
      )
      .limit(1);

    return result[0] || null;
  }

  async findActiveByRefreshTokenHash(refreshTokenHash) {
    const result = await db
      .select()
      .from(session)
      .where(
        and(
          eq(session.refreshTokenHash, refreshTokenHash),
          eq(session.isActive, true),
          eq(session.softDelete, false),
          gt(session.refreshTokenExpiresAt, new Date()),
        ),
      )
      .limit(1);

    return result[0] || null;
  }

  async rotateRefreshToken(id, data) {
    const result = await db
      .update(session)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(session.id, id), eq(session.softDelete, false)))
      .returning();

    return result[0] || null;
  }

  async revokeById(id) {
    const result = await db
      .update(session)
      .set({
        isActive: false,
        logoutTime: new Date(),
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(eq(session.id, id))
      .returning();

    return result[0] || null;
  }

  async deleteByPatientId(userId) {
    return db.delete(session).where(eq(session.userId, userId)).returning();
  }
}

module.exports = new SessionRepository();
