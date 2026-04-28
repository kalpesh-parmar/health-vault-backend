const { and, asc, count, desc, eq, ilike, or, sql } = require("drizzle-orm");

const { db } = require("../configs/db");
const { patient } = require("../models/patient");

const patientSortColumns = Object.freeze({
  createdAt: patient.createdAt,
  email: patient.email,
  fullName: patient.fullName,
  status: patient.status,
  updatedAt: patient.updatedAt,
});

function buildPatientFilters(filters = {}) {
  const conditions = [eq(patient.softDelete, false)];

  if (filters.status) {
    conditions.push(eq(patient.status, filters.status));
  }

  if (filters.search) {
    const search = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(patient.email, search),
        ilike(patient.fullName, search),
        ilike(patient.phone, search),
      ),
    );
  }

  return and(...conditions);
}

class PatientRepository {
  async create(data) {
    const result = await db.insert(patient).values(data).returning();
    return result[0] || null;
  }

  async findById(id) {
    const result = await db
      .select()
      .from(patient)
      .where(and(eq(patient.id, id), eq(patient.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async findByEmail(email) {
    const result = await db
      .select()
      .from(patient)
      .where(and(eq(patient.email, email), eq(patient.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async findByEmailExcludingId(email, id) {
    const result = await db
      .select()
      .from(patient)
      .where(
        and(eq(patient.email, email), sql`${patient.id} <> ${id}`, eq(patient.softDelete, false)),
      )
      .limit(1);

    return result[0] || null;
  }

  async findByPatientCode(patientCode) {
    const result = await db
      .select()
      .from(patient)
      .where(eq(patient.patientCode, patientCode))
      .limit(1);

    return result[0] || null;
  }

  async findAll(filters = {}) {
    const sortColumn = patientSortColumns[filters.sortBy] || patient.createdAt;
    const orderBy = filters.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
    const limit = filters.limit;
    const offset = filters.offset;
    const where = buildPatientFilters(filters);

    const rows = await db
      .select()
      .from(patient)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);
    const totalRows = await db.select({ total: count() }).from(patient).where(where);

    return {
      rows,
      total: Number(totalRows[0]?.total || 0),
    };
  }

  async updateById(id, data) {
    const result = await db
      .update(patient)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(patient.id, id), eq(patient.softDelete, false)))
      .returning();

    return result[0] || null;
  }

  async softDeleteById(id) {
    const result = await db
      .update(patient)
      .set({
        deletedAt: new Date(),
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(and(eq(patient.id, id), eq(patient.softDelete, false)))
      .returning();

    return result[0] || null;
  }

  async hardDeleteById(id) {
    const result = await db.delete(patient).where(eq(patient.id, id)).returning();
    return result[0] || null;
  }
}

module.exports = new PatientRepository();
