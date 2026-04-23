const { any } = require("zod");
const { db } = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");
const { User } = require("../models/User");

class userRepository {
  //Login USer
  async loginUser(email) {
    const user = await db
      .select()
      .from(User)
      .where(eq(User.email, email))
      .limit(1);
    return user[0];
  }

  //Create User
  async createUser(data) {
    return await db.insert(User).values(data).returning();
  }

  //get user by id if not delted
  async getUserById(id) {
    const result = await db
      .select()
      .from(User)
      .where(and(eq(User.id, id), eq(User.softDelete, false)));
    return result[0];
  }

  //get all user
  async getUserList() {
    return await db.select().from(User).where(eq(User.softDelete, false));
  }

  async updateUser(id, data) {
    const result = await db
      .update(User)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(User.id, Number(id)), eq(User.softDelete, false)))
      .returning();

    return result[0];
  }

  //soft delte
  async deleteUser(id) {
    const result = await db
      .update(User)
      .set({
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(and(eq(User.id, id), eq(User.softDelete, false)))
      .returning();

    return result[0];
  }
  async findUserByEmail(email) {
    const user = await db
      .select()
      .from(User)
      .where(and(eq(User.email, email), eq(User.softDelete, false)))
      .limit(1);

    return user.length ? user[0] : null;
  }
}

module.exports = new userRepository();
