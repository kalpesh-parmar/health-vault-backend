const { and, desc, eq } = require("drizzle-orm");
const { db } = require("../configs/db");
const { userOnboarding } = require("../models/userOnboarding");

class UserOnboardingRepository {
  /**
   * Create a new onboarding record
   * @param {Object} data - Onboarding data
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<Object|null>} Created record or null
   */
  async create(data, client = db) {
    const target = client || db;
    const result = await target.insert(userOnboarding).values(data).returning();
    return result[0] || null;
  }

  /**
   * Find onboarding record by user ID
   * @param {string} userId - User ID
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<Object|null>} Onboarding record or null
   */
  async findByUserId(userId, client = db) {
    const target = client || db;
    const result = await target
      .select()
      .from(userOnboarding)
      .where(eq(userOnboarding.userId, userId))
      .orderBy(desc(userOnboarding.updatedAt))
      .limit(1);

    return result[0] || null;
  }

  /**
   * Update onboarding record by user ID
   * @param {string} userId - User ID
   * @param {Object} data - Data to update
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<Object|null>} Updated record or null
   */
  async updateByUserId(userId, data, client = db) {
    const target = client || db;
    const result = await target
      .update(userOnboarding)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(userOnboarding.userId, userId))
      .returning();

    return result[0] || null;
  }

  /**
   * Atomic / Transaction-safe Upsert by User ID
   * @param {string} userId - User ID
   * @param {Object} payload - Data payload { data, isCompleted, step }
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<Object|null>} Saved onboarding record
   */
  async upsertByUserId(userId, { data, isCompleted, step = 1 }, client = db) {
    const target = client || db;
    const existing = await this.findByUserId(userId, target);
    if (existing) {
      return await this.updateByUserId(
        userId,
        {
          data,
          isCompleted: isCompleted !== undefined ? isCompleted : existing.isCompleted,
          step: step !== undefined ? step : existing.step,
        },
        target,
      );
    } else {
      return await this.create(
        {
          userId,
          data,
          isCompleted: isCompleted || false,
          step,
        },
        target,
      );
    }
  }

  /**
   * Check if onboarding is completed for user
   * @param {string} userId - User ID
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<boolean>} True if completed, false otherwise
   */
  async isCompleted(userId, client = db) {
    const target = client || db;
    const result = await target
      .select()
      .from(userOnboarding)
      .where(and(eq(userOnboarding.userId, userId), eq(userOnboarding.isCompleted, true)))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Get current step and data for user
   * @param {string} userId - User ID
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<Object>} Current step and data
   */
  async getCurrentState(userId, client = db) {
    const record = await this.findByUserId(userId, client);
    if (!record) {
      return null;
    }

    return {
      step: record.step,
      data: record.data || {},
      isCompleted: record.isCompleted,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Delete onboarding record by user ID
   * @param {string} userId - User ID
   * @param {Object} [client=db] - Database client or transaction
   * @returns {Promise<boolean>} True if deleted, false otherwise
   */
  async deleteByUserId(userId, client = db) {
    const target = client || db;
    const result = await target
      .delete(userOnboarding)
      .where(eq(userOnboarding.userId, userId))
      .returning();

    return result.length > 0;
  }
}

module.exports = new UserOnboardingRepository();
