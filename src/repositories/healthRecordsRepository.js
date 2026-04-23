const { any } = require("zod");
const { db } = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");
const { healthRecords } = require("../models/Health_Recode");

class healthRecordsRepository {

  //permanent delete health record by id
  async permanentDeleteHealthRecord(id) {
    const result = await db
      .delete(healthRecords)
      .where(eq(healthRecords.id, id));
    return result[0] || null;
  }
}

module.exports = new healthRecordsRepository();
