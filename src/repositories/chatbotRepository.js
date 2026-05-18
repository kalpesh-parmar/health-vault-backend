const { db } = require("../configs/db");
const { AIsummary } = require("../models/AIsummary");

class chatbotRepository {
  async createSummary(data) {
    // console.log("data===",data);

    const result = await db.insert(AIsummary).values(data).returning();
    return result[0] || null;
  }
}

module.exports = new chatbotRepository();
