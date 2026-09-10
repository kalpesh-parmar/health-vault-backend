const dashboardService = require("../services/dashboard.service");
const { successResponse } = require("../helpers/generalResponse");
const { messageConstants } = require("../constants/messageConstants");

class DashboardController {
  getSummaryCount = async (req, res, next) => {
    try {
      const data = await dashboardService.getSummaryCount(req.auth.userId);

      return successResponse(res, data, messageConstants.DASHBOARD_SUMMARY_FETCHED);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = new DashboardController();
