const { any } = require("zod");
const { db } = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");
const { Document } = require("../models/Document");

class documentRepository {
  

  //permanent delete document by id
  async permanentDeleteDocument(id) {
    const result = await db
      .delete(Document)
      .where(eq(Document.id, id));
    return result[0] || null;
  }
}

module.exports = new documentRepository();
