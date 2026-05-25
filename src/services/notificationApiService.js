const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException } = require("../exceptions/appError");
const notificationRepository = require("../repositories/notificationRepository");
const {
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  notificationIdParamSchema,
  testSendNotificationSchema,
  userIdBodySchema,
  validateSchema,
} = require("../validations");

class NotificationApiService {
  async testSend(userId, payload) {
    const data = await validateSchema(testSendNotificationSchema, payload);
    return await notificationRepository.create(data);
  }

  async list(payload) {
    const data = await validateSchema(listNotificationsSchema, payload || {});
    return notificationRepository.list(data);
  }

  async listPaginated(payload) {
    const data = await validateSchema(listNotificationsPaginatedSchema, payload);
    return notificationRepository.listPaginated(data);
  }

  async markRead(params) {
    const data = await validateSchema(notificationIdParamSchema, params);
    const existingNotification = await notificationRepository.findById(data.id);

    if (!existingNotification) {
      throw new NotFoundException(errorConstants.NOTIFICATION_NOT_FOUND);
    }

    return notificationRepository.markRead(data.id);
  }

  async markAllRead(payload) {
    const data = await validateSchema(userIdBodySchema, payload);
    return notificationRepository.markAllRead(data.userId);
  }

  async delete(params) {
    const data = await validateSchema(notificationIdParamSchema, params);
    const deletedNotification = await notificationRepository.deleteById(data.id);

    if (!deletedNotification) {
      throw new NotFoundException(errorConstants.NOTIFICATION_NOT_FOUND);
    }

    return deletedNotification;
  }

  async badgeCount(payload) {
    const count = await notificationRepository.getUnreadCount(payload);
    return { count };
  }
}

module.exports = new NotificationApiService();
