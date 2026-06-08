const refillRepository = require("../repositories/refillRepository");

class refillService {
  async badgeCount(payload) {
    const count = await refillRepository.getUnreadCount(payload.medicationId);
    return { count };
  }
}
module.exports = new refillService();
