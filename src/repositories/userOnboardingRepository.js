const { and, desc, eq } = require("drizzle-orm");
const { db } = require("../configs/db");
const { userOnboarding } = require("../models/userOnboarding");

class UserOnboardingRepository {
  /**
   * Create a new onboarding record
   * @param {Object} data - Onboarding data
   * @returns {Promise<Object|null>} Created record or null
   */
  async create(data) {
    const result = await db.insert(userOnboarding).values(data).returning();
    return result[0] || null;
  }

  /**
   * Find onboarding record by user ID
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Onboarding record or null
   */
  async findByUserId(userId) {
    const result = await db
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
   * @returns {Promise<Object|null>} Updated record or null
   */
  async updateByUserId(userId, data) {
    const result = await db
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
   * Check if onboarding is completed for user
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if completed, false otherwise
   */
  async isCompleted(userId) {
    const result = await db
      .select()
      .from(userOnboarding)
      .where(and(eq(userOnboarding.userId, userId), eq(userOnboarding.isCompleted, true)))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Get current step and data for user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Current step and data
   */
  async getCurrentState(userId) {
    const record = await this.findByUserId(userId);
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
   * @returns {Promise<boolean>} True if deleted, false otherwise
   */
  async deleteByUserId(userId) {
    const result = await db
      .delete(userOnboarding)
      .where(eq(userOnboarding.userId, userId))
      .returning();

    return result.length > 0;
  }
}

module.exports = new UserOnboardingRepository();
