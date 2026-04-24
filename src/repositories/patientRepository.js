const { any } = require("zod");
const { db } = require("../config/db");
const { session } = require("../models/session");
const { eq, and } = require("drizzle-orm");
const { Patient } = require("../models/patient");

class patientRepository {
  //Login USer
  async loginPatient(email) {
    const user = await db
      .select()
      .from(Patient)
      .where(eq(Patient.email, email))
      .limit(1);
    return user[0] ?? null;
  }

  //Create User
  async createPatient(data) {
    const result= await db
      .insert(Patient)
      .values(data)
      .returning();
    return result[0]??null;
  }

  //get user by id if not delted
  async getPatientById(id) {
    const result = await db
      .select()
      .from(Patient)
      .where(and(eq(Patient.id, id), eq(Patient.softDelete, false)))
      .limit(1);
    return result[0]??null;
  }

  //get all user
  async getPatientList() {
    const result= await db
      .select()
      .from(Patient)
      .where(eq(Patient.softDelete, false));
    return result[0] ?? null;
  }

  async updatePatient(id, data) {
    const result = await db
      .update(Patient)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(Patient.id, Number(id)), eq(Patient.softDelete, false)))
      .returning();

    return result[0]??null;
  }

  //soft delete
  async deletePatient(id) {
    const result = await db
      .update(Patient)
      .set({
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(and(eq(Patient.id, id), eq(Patient.softDelete, false)))
      .returning();

    return result[0]??null;
  }
  async findPatientByEmail(email) {
    const user = await db
      .select()
      .from(Patient)
      .where(and(eq(Patient.email, email), eq(Patient.softDelete, false)))
      .limit(1);

    return user.length ? user[0] : null;
  }

  //permanent delete patient by id
  async permanentDeletePatient(id) {
    const result = await db
      .delete(Patient)
      .where(eq(Patient.id, id))
      .returning();
    return result[0] || null;
  }
}

module.exports = new patientRepository();
