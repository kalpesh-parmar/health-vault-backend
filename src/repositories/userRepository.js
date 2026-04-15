const { any } = require("zod");
const db = require("../config/db");
const { user } = require("../models/User");
const { eq, and } = require("drizzle-orm");

class userRepository {
  //Login USer
  async loginUser(email) {
    const user = await db
      .select()
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    return user || null;
  }

  //create user
  async createUser(data) {
    const result = await db.insert(user).values(data).returning();
    return result[0];
    //retutn object array
  }

  //get user by id if not delted
  async getUserById(id) {
    const result = await db
      .select()
      .form(user)
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