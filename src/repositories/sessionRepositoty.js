const { any } = require("zod");
const { db } = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");

class SessionRepository {
  async create(data) {
    const result = await db.insert(session).values(data).returning();
    return result[0];
  }

  async findById(id) {
    const result = await db
      .select()
      .from(session)
      .where(and(eq(session.id, id), eq(session.softDelete, false)));
      return result[0];
  }

  async logout(sessionId) {
    const result = await db
      .update(session)
      .set({
        logoutTime: new Date(),
        softDelete: true,
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(session.id, sessionId))
      .returning();

    return result[0];
  }
}

module.exports = new SessionRepository();
