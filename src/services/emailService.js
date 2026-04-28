const nodemailer = require("nodemailer");
const { env } = require("../configs/env");
const renderUtils = require("../utils/renderUtils");

class EmailService {
  constructor() {
    this.transporter = null;
  }

  getTransporter() {
    if (!env.emailEnabled) {
      return null;
    }

    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.smtpHost,
        port: Number(env.smtpPort),
        secure: false, // for 587

        auth:
          env.smtpUser && env.smtpPassword
            ? {
                user: env.smtpUser,
                pass: env.smtpPassword,
              }
            : undefined,

        tls: {
          rejectUnauthorized: false,
        },
      });
    }

    return this.transporter;
  }

  async sendTemplateEmail({ subject, templateName, to, variables = {} }) {
    try {
      const transporter = this.getTransporter();
      const html = await renderUtils.render(templateName, {
        ...variables,
        appName: env.appName,
      });
      if (!transporter) {
        return {
          html,
          skipped: true,
        };
      }
      const emailData = {
        from: env.emailFrom,
        html,
        subject,
        to,
      };
      return transporter.sendMail(emailData);
    } catch (error) {
      console.error("sendTemplateEmail error: ", error);
      return {
        error,
        skipped: true,
      };
    }
  }

  async sendOtpEmail(patient, otp, templateName = "otpVerification") {
    return this.sendTemplateEmail({
      subject: "Your Health Vault verification code",
      templateName,
      to: patient.email,
      variables: {
        message: "Use this code to continue your secure Health Vault flow.",
        name: patient.fullName,
        otp,
      },
    });
  }

  async sendPasswordResetSuccessEmail(patient) {
    return this.sendTemplateEmail({
      subject: "Your Health Vault password was reset",
      templateName: "resetPasswordSuccess",
      to: patient.email,
      variables: {
        message: "Your password was reset successfully.",
        name: patient.fullName,
      },
    });
  }

  async sendAccountBlockedEmail(patient) {
    return this.sendTemplateEmail({
      subject: "Your Health Vault account is blocked",
      templateName: "accountBlocked",
      to: patient.email,
      variables: {
        message: "Your account was blocked after too many failed security attempts.",
        name: patient.fullName,
      },
    });
  }
}

module.exports = new EmailService();
