const refillRepository = require("../repositories/refillRepository");
const { validateSchema, listRefillQuerySchema } = require("../validations");

class refillService {
  async badgeCount(payload) {
    const count = await refillRepository.getUnreadCount(payload.medicationId);
    return { count };
  }
  async getRefillList(userId) {
    const list = await refillRepository.getRefillList(userId);
    return list;
  }
  async getRefillListPagination(payload, userId) {
    //filter using medication Id or total quantity number or remaining quantity
    const filters = await validateSchema(listRefillQuerySchema, payload || {});

    const { page = 1, pageLimit } = payload.page;
    const skip = (page - 1) * pageLimit;
    const [record, totalCount] = await Promise.all([
      refillRepository.findAllWithFilters({
        ...filters,
        userId,
        skip,
        limit: pageLimit,
      }),
      refillRepository.count({ ...filters, userId }),
    ]);
    const totalPages = Math.ceil(totalCount / pageLimit);
    const hasNextPage = page * pageLimit < totalCount;
    const hasPrevPage = page > 1;
    const pagination = {
      page,
      limit: pageLimit,
      totalRecord: totalCount,
      totalPages: totalPages,
      hasNextPage: hasNextPage,
      hasPrevPage: hasPrevPage,
    };
    return { record, pagination };
  }
}
module.exports = new refillService();
