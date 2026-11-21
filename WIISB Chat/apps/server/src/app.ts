import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { join } from "node:path";
import { Database } from "./db.js";
import { config } from "./config.js";
import { ApiError, fail } from "./core.js";
import { Hub, realtimeRoutes } from "./realtime.js";
import { authRoutes } from "./auth.js";
import { socialRoutes } from "./social.js";
import { communityRoutes } from "./communities.js";
import { messageRoutes } from "./messages.js";
import { mediaRoutes } from "./media.js";
import { voiceRoutes } from "./voice.js";
import { createStorage } from "./storage.js";
import { collectStorage } from "./cleanup.js";
import { createMailer, type Mailer } from "./mail.js";
import { recoveryRoutes } from "./recovery.js";
export async function createApp(
  options: {
    dataDir?: string;
    databaseUrl?: string;
    logger?: boolean;
    /** Tests supply their own mailer and a shorter "wait before another code" delay. */
    mailer?: Mailer;
    mailCooldownMs?: number;
  } = {},
) {
  const dataDir = options.dataDir || config.dataDir;
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.body.password",
            "req.body.refresh",
            "req.query.ticket",
          ],
          serializers: {
            req: (r) => ({
              method: r.method,
              url: r.url
                ?.split("?")[0]
                .replace(/(\/v1\/invites\/)[^/]+/, "$1[redacted]"),
            }),
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "true",
  });
  const db = await new Database().open(
    options.databaseUrl || config.databaseUrl,
    join(dataDir, "postgres"),
  );
  const hub = new Hub(db),
    storage = createStorage(join(dataDir, "media")),
    mailer = options.mailer || createMailer(),
    services = { db, hub, storage, mailer };
  let collecting = false;
  const cleanup = setInterval(() => {
    if (collecting) return;
    collecting = true;
    void collectStorage(services)
      .catch((e) => app.log.error({ err: e }, "Storage cleanup failed"))
      .finally(() => (collecting = false));
  }, 3600000);
  cleanup.unref();
  await app.register(cors, {
    origin: config.origins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: config.maxUpload, files: 1, fields: 0 },
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply
        .status(400)
        .send({
          code: "invalid_input",
          message: error.issues
            .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
            .join("; "),
        });
    if (error instanceof ApiError)
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message });
    const e = error as any,
      code = e.code || e.cause?.code;
    if (code === "23505")
      return reply
        .status(409)
        .send({ code: "conflict", message: "That entry already exists." });
    if (code === "23503" || code === "22P02")
      return reply
        .status(400)
        .send({
          code: "invalid_reference",
          message: "The requested resource is unavailable.",
        });
    if (e.statusCode && e.statusCode < 500)
      return reply
        .status(e.statusCode)
        .send({ code: e.code || "request_failed", message: e.message });
    app.log.error(
      { error: e.name, code: code || "internal" },
      "Request failed",
    );
    return reply
      .status(500)
      .send({
        code: "server_error",
        message: "The server could not complete this request.",
      });
  });
  await authRoutes(app, services);
  await recoveryRoutes(app, services, { cooldownMs: options.mailCooldownMs });
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, service: "wiisb-chat" };
  });
  app.get("/v1/info", async () => ({
    name: "WIISB Chat",
    version: "0.1.0",
    protocol: 1,
    maxUploadBytes: config.maxUpload,
    media: !!config.livekitUrl,
    emailRecovery: mailer.enabled,
    recovery: mailer.enabled
      ? "Link an email in Settings to reset a forgotten password by email."
      : "Contact the host administrator. Email recovery is not configured.",
    features: { payments: false },
  }));
  await realtimeRoutes(app, hub);
  await socialRoutes(app, services);
  await communityRoutes(app, services);
  await messageRoutes(app, services);
  await mediaRoutes(app, services);
  await voiceRoutes(app, services);
  app.get("/v1/admin/health", async (req) => {
    if (!config.adminIds.includes(req.identity.uid))
      fail("forbidden", "Platform administrator access required.", 403);
    return {
      clients: hub.clients.size,
      users: (await db.query("SELECT count(*)::int AS total FROM users"))[0]
        .total,
      reports: await db.query(
        "SELECT * FROM reports ORDER BY created_at DESC LIMIT 100",
      ),
    };
  });
  app.post("/v1/admin/users/:id/suspend", async (req) => {
    if (!config.adminIds.includes(req.identity.uid))
      fail("forbidden", "Platform administrator access required.", 403);
    const uid = (req.params as any).id;
    await db.query("UPDATE users SET suspended=true WHERE id=$1", [uid]);
    hub.closeUser(uid);
    return { ok: true };
  });
  app.addHook("preClose", async () => {
    clearInterval(cleanup);
    hub.close();
  });
  app.addHook("onClose", async () => {
    hub.close();
    await db.close();
  });
  await app.ready();
  return { app, ...services };
}
