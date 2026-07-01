const { and, eq } = require("drizzle-orm");
const { db } = require("../configs/db");
const { authProvider } = require("../models/authProvider");

class AuthProviderRepository {
  async create(data) {
    const result = await db.insert(authProvider).values(data).returning();
    return result[0] || null;
  }

  async findByProvider(provider, providerUserId) {
    const result = await db
      .select()
      .from(authProvider)
      .where(
        and(
          eq(authProvider.provider, provider),
          eq(authProvider.providerUserId, providerUserId),
          eq(authProvider.softDelete, false),
        ),
      )
      .limit(1);

    return result[0] || null;
  }
}

module.exports = new AuthProviderRepository();
