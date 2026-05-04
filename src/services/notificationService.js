const { getFirebaseMessaging } = require("../configs/firebase");

class NotificationService {
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
