const { any } = require("zod");
const { db } = require("../config/db"); 
const { user: userTable } = require("../models/User");
const {session:sessionTable}=require("../models/session")
const { eq, and } = require("drizzle-orm");

class userRepository {
  //Login USer
  async loginUser(email) {
  
  const user=await db
  .select()
  .from(userTable)
  .where(eq(userTable.email, email))
  .limit(1);
  return user[0];
  }
createSession = async ({ userId }) => {
  return db.insert(sessionTable).values({
    userId: userId,
    loginTime: new Date(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
};
  //Create User
  async createUser(data) {
    return await db
      .insert(userTable)
      .values({
        userName: data.userName,
        email: data.email,
        password: data.password,
      })
      .returning();
  }

  //get user by id if not delted
  async getUserById(id) {
    const result = await db
      .select()
      .from(user)
      .where(and(eq(user.id, id), eq(user.softDelete, false)));
    return result[0];
  }

  //updated user if not delted
  async updateUser(id, data) {
    const result = await db
      .update(user)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(user.id, id), eq(user.softDelete, false)))
      .returning();
    return result[0];
  }

  //soft delte
  async deleteUser(id) {
    const result = await db
      .update(user)
      .set({
        softDeleted: true,
        updateUser: new Date(),
      })
      .where(and(eq(user.id, id), eq(user.softDelete, false)))
      .returning();

    return result[0];
  }
}

module.exports = new userRepository();
