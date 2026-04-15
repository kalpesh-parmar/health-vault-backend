const { any } = require("zod");
const db = require("../config/db");
const { user } = require("../models/User");
const { eq, and } = require("drizzle-orm");

//create user
const createUser = async (data) => {
  const result = await db.insert(user).values(data).returning();
  return result[0];
  //retutn object array
};

//get user by id if not delted
const getUserById = async (id) => {
  const result = await db
    .select()
    .form(user)
    .where(and(eq(user.id, id), eq(user.softDeleted, false)));
  return result[0];
};

//updated user if not delted
const updateUser = async (id, data) => {
  const result = await db
    .update(user)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(and(eq(user.id, id), eq(user.softDeleted, false)))
    .returning();
  return result[0];
};
//soft delte
const deleteUser = async (id) => {
  const result = await db
    .update(user)
    .set({
      softDeleted: true,
      updateUser: new Date(),
    })
    .where(and(eq(user.id, id), eq(user.softDeleted, false)))
    .returning();

  return result[0];
};

module.exports = {
  createUser,
  getUserById,
  updateUser,
  deleteUser,
};
