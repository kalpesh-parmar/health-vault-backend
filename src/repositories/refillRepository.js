const { sql, eq, and } = require("drizzle-orm");
const { db } = require("../configs/db");
const { refillCount } = require("../models/refillCount");

class refillRepository {
  async add(data) {
    const result = await db.insert(refillCount).values(data).returning();
    return result[0] || null;
  }
  async getUnreadCount(medicationId) {
    const result = await db
      .select({ count: sql`count(*)` })
      .from(refillCount)
      .where(and(eq(refillCount.medicationId, medicationId)));

    return Number(result[0].count);
  }
}
module.exports = new refillRepository();
