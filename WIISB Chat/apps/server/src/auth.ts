import type { FastifyInstance } from "fastify";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "./config.js";
import {
  body,
  id,
  secret,
  digest,
  fail,
  publicUser,
  type Identity,
  type Services,
} from "./core.js";
import type { Query } from "./db.js";

const key = new TextEncoder().encode(config.jwtSecret);
const credentials = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/),
  password: z.string().min(10).max(128),
});
export const passwordHash = (password: string) =>
  hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export async function activeIdentity(
  db: Query,
  token: string,
): Promise<Identity> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: "wiisb-chat",
      audience: "wiisb-client",
      algorithms: ["HS256"],
    });
    const uid = String(payload.sub),
      sid = String(payload.sid);
    if (
      !(
        await db.query(
          "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.suspended",
          [sid, uid],
        )
      ).length
    )
      fail("unauthorized", "Your session has expired.", 401);
    return { uid, sid };
  } catch {
    fail("unauthorized", "Please sign in again.", 401);
  }
}
async function issue(db: Query, uid: string, sid: string) {
  const refresh = secret();
  await db.query("INSERT INTO refresh_tokens(hash,session_id) VALUES($1,$2)", [
    digest(refresh),
    sid,
  ]);
  const access = await new SignJWT({ sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(uid)
    .setIssuer("wiisb-chat")
    .setAudience("wiisb-client")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
  return {
    access,
    refresh,
    user: (
      await db.query(
        `SELECT ${publicUser},settings,presence FROM users WHERE id=$1`,
        [uid],
      )
    )[0],
  };
}
export async function authRoutes(app: FastifyInstance, { db, hub }: Services) {
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0];
    if (
      req.method === "OPTIONS" ||
      path === "/health" ||
      path === "/v1/info" ||
      path === "/v1/events" ||
      [
        "/v1/auth/register",
        "/v1/auth/login",
        "/v1/auth/refresh",
        "/v1/auth/forgot",
        "/v1/auth/reset",
      ].includes(path)
    )
      return;
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) fail("unauthorized", "Sign in to continue.", 401);
    req.identity = await activeIdentity(db, token);
  });
  app.post(
    "/v1/auth/register",
    { config: { rateLimit: { max: 8, timeWindow: "1 hour" } } },
    async (req) => {
      const data = body(
        req,
        credentials.extend({
          displayName: z.string().trim().min(1).max(80).optional(),
        }),
      );
      const uid = id(),
        sid = id(),
        pw = await passwordHash(data.password);
      return db.transaction(async (tx) => {
        if (
          (
            await tx.query("SELECT 1 FROM users WHERE username=$1", [
              data.username,
            ])
          ).length
        )
          fail("username_taken", "That username is already in use.", 409);
        await tx.query(
          "INSERT INTO users(id,username,password_hash,display_name) VALUES($1,$2,$3,$4)",
          [uid, data.username, pw, data.displayName || data.username],
        );
        await tx.query(
          "INSERT INTO sessions(id,user_id,label,expires_at) VALUES($1,$2,'Windows desktop',now()+interval '30 days')",
          [sid, uid],
        );
        return issue(tx, uid, sid);
      });
    },
  );
  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req) => {
      const data = body(req, credentials);
      const [user] = await db.query("SELECT * FROM users WHERE username=$1", [
        data.username,
      ]);
      // A fixed valid dummy hash keeps unknown usernames on the same costly path.
      const dummy = await dummyHash;
      if (
        !(await verify(user?.password_hash || dummy, data.password)) ||
        !user ||
        user.suspended
      )
        fail("invalid_credentials", "Incorrect username or password.", 401);
      const sid = id();
      return db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO sessions(id,user_id,label,expires_at) VALUES($1,$2,'Windows desktop',now()+interval '30 days')",
          [sid, user.id],
        );
        return issue(tx, user.id, sid);
      });
    },
  );
  app.post(
    "/v1/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const { refresh } = body(
        req,
        z.object({ refresh: z.string().min(20).max(200) }),
      );
      const result = await db.transaction(async (tx) => {
        const [row] = await tx.query(
          "SELECT r.*,s.user_id,s.expires_at,s.revoked_at,u.suspended FROM refresh_tokens r JOIN sessions s ON s.id=r.session_id JOIN users u ON u.id=s.user_id WHERE r.hash=$1 FOR UPDATE",
          [digest(refresh)],
        );
        if (
          !row ||
          row.revoked_at ||
          row.suspended ||
          new Date(row.expires_at) <= new Date()
        )
          return null;
        if (row.used_at) {
          await tx.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
            row.session_id,
          ]);
          return null;
        }
        await tx.query(
          "UPDATE refresh_tokens SET used_at=now() WHERE hash=$1",
          [digest(refresh)],
        );
        return issue(tx, row.user_id, row.session_id);
      });
      if (!result)
        fail("unauthorized", "Session expired or reused. Sign in again.", 401);
      return result;
    },
  );
  app.post("/v1/auth/logout", async (req) => {
    await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      req.identity.sid,
    ]);
    hub.closeSession(req.identity.sid);
    return { ok: true };
  });
  app.get("/v1/sessions", async (req) => ({
    sessions: await db.query(
      "SELECT id,label,created_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC",
      [req.identity.uid],
    ),
    current: req.identity.sid,
  }));
  app.delete("/v1/sessions/:id", async (req) => {
    const sid = (req.params as any).id;
    await db.query(
      "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2",
      [sid, req.identity.uid],
    );
    hub.closeSession(sid);
    return { ok: true };
  });
  app.post("/v1/auth/password", async (req) => {
    const data = body(
      req,
      z.object({
        current: z.string().max(128),
        password: credentials.shape.password,
      }),
    );
    const [user] = await db.query(
      "SELECT password_hash FROM users WHERE id=$1",
      [req.identity.uid],
    );
    if (!(await verify(user.password_hash, data.current)))
      fail("invalid_credentials", "Current password is incorrect.", 401);
    const pw = await passwordHash(data.password);
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        pw,
        req.identity.uid,
      ]);
      await tx.query(
        "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2",
        [req.identity.uid, req.identity.sid],
      );
    });
    hub.closeUser(req.identity.uid, req.identity.sid);
    return { ok: true };
  });
  app.delete("/v1/account", async (req) => {
    const { password } = body(req, z.object({ password: z.string().max(128) }));
    const [user] = await db.query(
      "SELECT password_hash FROM users WHERE id=$1",
      [req.identity.uid],
    );
    if (!(await verify(user.password_hash, password)))
      fail("invalid_credentials", "Password is incorrect.", 401);
    if (
      (
        await db.query("SELECT 1 FROM communities WHERE owner_id=$1", [
          req.identity.uid,
        ])
      ).length
    )
      fail(
        "owns_server",
        "Transfer or delete your communities before deleting your account.",
      );
    await db.query("DELETE FROM users WHERE id=$1", [req.identity.uid]);
    hub.closeUser(req.identity.uid);
    return { ok: true };
  });
}
const dummyHash = passwordHash("unusable-" + secret());
