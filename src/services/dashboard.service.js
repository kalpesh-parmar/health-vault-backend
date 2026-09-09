const dashboardRepository = require("../repositories/dashboard.repository");

class DashboardService {
  /**
   * Get the dashboard summary counts for a user.
   * @param {string} userId - The ID of the user.
   * @returns {Promise<Object>} An object containing medicinesCount, documentsCount, and todayDosesCount.
   */
  async getSummaryCount(userId) {
    const [medicinesCount, documentsCount, todayDosesCount] = await Promise.all([
      dashboardRepository.getMedicinesCount(userId),
      dashboardRepository.getDocumentsCount(userId),
      dashboardRepository.getTodayDosesCount(userId),
    ]);

    return {
      medicinesCount,
      documentsCount,
      todayDosesCount,
    };
  }
}

module.exports = new DashboardService();
