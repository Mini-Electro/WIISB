import nodemailer from "nodemailer";
import { config } from "./config.js";

export type Mail = { to: string; subject: string; text: string };
export interface Mailer {
  /** False when the host has not set up outgoing email: email features are then unavailable. */
  enabled: boolean;
  send(mail: Mail): Promise<void>;
}

/**
 * Production sends through the host's SMTP server (SMTP_HOST, MAIL_FROM, ...).
 * Without SMTP, development servers print the message to the console so the flow can be tried locally;
 * a production server without SMTP simply reports email as unavailable.
 */
export function createMailer(): Mailer {
  if (config.smtpHost && config.mailFrom) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    return {
      enabled: true,
      send: async (mail) => {
        await transport.sendMail({ from: config.mailFrom, ...mail });
      },
    };
  }
  if (!config.production)
    return {
      enabled: true,
      send: async (mail) => {
        console.log(
          `\n[dev mail] To: ${mail.to}\n[dev mail] Subject: ${mail.subject}\n${mail.text}\n`,
        );
      },
    };
  return {
    enabled: false,
    send: async () => {
      throw new Error("Email is not configured on this server.");
    },
  };
}
