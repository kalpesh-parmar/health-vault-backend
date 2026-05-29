const { getFirebaseMessaging } = require("../configs/firebase");
const { errorConstants } = require("../constants/errorConstants");
const { InvalidRequestException } = require("../exceptions/appError");
const notificationRepository = require("../repositories/notificationRepository");
const sessionRepository = require("../repositories/sessionRepository");

class NotificationService {
  async sendToUser(userId, payload) {
    try {
      //getDeviceTokens for user
      const session = await sessionRepository.getTokenById(userId);

      const token = session.map((s) => s.deviceToken).filter(Boolean);
      if (!token.length) {
        throw new InvalidRequestException(errorConstants.NO_DEVICE_TOKEN);
      }
      const message = getFirebaseMessaging();
      if (!message) {
        throw new InvalidRequestException(errorConstants.FIREBASE_MESSAGING_NOT_CONNECTED);
      }
      //send notification to all device
      for (const tokens of token) {
        await message.send({
          token: tokens,
          data: payload.data || {},
          notification: {
            title: payload.title || "Health Vault Notification",
            body: payload.body,
          },
        });
      }
      const data = await notificationRepository.create({
        userId,
        title: payload.title,
        body: payload.body,
        data: payload.data,
      });
      console.log("notification Send successfully");
      return data;
    } catch (error) {
      console.error(" NotificationService error:", error);
      throw new InvalidRequestException(errorConstants.NOTIFICATION_FAILED);
    }
  }

  async sendToDevice({ data = {}, notification, token }) {
    const messaging = getFirebaseMessaging();

    if (!messaging) {
      return {
        skipped: true,
      };
    }

    const message = {
      data,
      notification,
      token,
    };

    return messaging.send(message);
  }
}

module.exports = new NotificationService();
