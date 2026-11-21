import "dotenv/config";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
export const config = {
  production: process.env.NODE_ENV === "production",
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 4310),
  dataDir: resolve(process.env.DATA_DIR || ".data"),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || randomBytes(48).toString("hex"),
  origins: (
    process.env.CORS_ORIGINS ||
    "http://localhost:1432,http://127.0.0.1:1432,http://tauri.localhost,tauri://localhost"
  ).split(","),
  maxUpload: Number(process.env.MAX_UPLOAD_MB || 64) * 1024 * 1024,
  userStorage: Number(process.env.USER_STORAGE_MB || 2048) * 1024 * 1024,
  livekitUrl: process.env.LIVEKIT_URL || "",
  livekitInternal:
    process.env.LIVEKIT_INTERNAL_URL || process.env.LIVEKIT_URL || "",
  livekitKey: process.env.LIVEKIT_API_KEY || "",
  livekitSecret: process.env.LIVEKIT_API_SECRET || "",
  storage: process.env.STORAGE_ADAPTER || "local",
  s3Bucket: process.env.S3_BUCKET || "",
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION || "us-east-1",
  adminIds: (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean),
  // Outgoing email (account recovery). Leave SMTP_HOST empty to turn email features off.
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || "",
};
if (
  config.production &&
  (!process.env.JWT_SECRET ||
    process.env.JWT_SECRET.length < 48 ||
    !config.databaseUrl)
) {
  throw new Error(
    "Production requires PostgreSQL DATABASE_URL and a random JWT_SECRET of at least 48 characters.",
  );
}
