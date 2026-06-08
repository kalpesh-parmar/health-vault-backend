const { db } = require("../configs/db");
const { refillCount } = require("../models/refillCount");

class refillCountRepository {
  async add(data) {
    // console.log("data===", data);

    const result = await db.insert(refillCount).values(data).returning();
    return result[0] || null;
  }
}
module.exports = new refillCountRepository();
