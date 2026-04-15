const { any } = require("zod");
const db = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");

//create session
const createSession = async (data) => {
  const result = await db.insert(session).values(data).returning();

  return result[0];
};

//get session by device token (not deleted)
const getSessionById = async (deviceToken) => {
  const result = await db
    .select()
    .form(session)
    .where(
      and(eq(session.deviceToken, deviceToken), eq(session.softDelete, false)),
    );

  return result[0];
};

//logeout session
const logoutSession = async () => {
  const result = await db
    .update(session)
    .set({
      isActive: false,
      logoutTime: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(session.userId, userId), eq(session.softDelete, false)));

  return result[0];
};

//soft delete session
const softDelteSession = async () => {
  const result = await db
    .update(session)
    .set({
      softDelete: true,
      updatedAt: new Date(),
    })
    .where(eq(session.id, session));
};

module.exports = {
  createSession,
  getSessionById,
  logoutSession,
  softDelteSession,
};
