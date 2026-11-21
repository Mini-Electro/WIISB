import type { FastifyInstance } from "fastify";
import { verify } from "@node-rs/argon2";
import { randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { body, id, digest, fail, type Services } from "./core.js";
import type { Query } from "./db.js";
import { passwordHash } from "./auth.js";

// Codes are 8 characters from an alphabet without look-alikes (about 40 bits). Only a salted hash is stored,
// a code lives 15 minutes, works once, and dies after 5 wrong tries, so guessing is hopeless.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ATTEMPTS = 5;
const address = z.string().trim().toLowerCase().max(254).pipe(z.email());
const codeInput = z.string().max(24);
const newPassword = z.string().min(10).max(128);
const BAD_CODE = "That code is wrong or has expired. Request a new one.";

const makeCode = () =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );
const pretty = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalise = (input: string) =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCode = (rowId: string, code: string) => digest(`${rowId}:${code}`);

type Purpose = "verify" | "reset";

async function issueCode(
  db: Query,
  uid: string,
  purpose: Purpose,
  email: string,
) {
  const code = makeCode(),
    rowId = id();
  // A newer code replaces every older one.
  await db.query(
    "UPDATE email_codes SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL",
    [uid, purpose],
  );
  await db.query(
    "INSERT INTO email_codes(id,user_id,purpose,email,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",
    [rowId, uid, purpose, email, hashCode(rowId, code)],
  );
  return { code, rowId };
}

/** Checks a typed code against the user's newest live code. Returns the address it was sent to, or null. */
async function consumeCode(
  db: Query,
  uid: string,
  purpose: Purpose,
  typed: string,
): Promise<string | null> {
  const [row] = await db.query(
    "SELECT id,email,code_hash FROM email_codes WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
    [uid, purpose],
  );
  if (!row) return null;
  // The try is counted before the comparison, atomically, so parallel guesses cannot exceed the limit.
  const counted = await db.query(
    "UPDATE email_codes SET attempts=attempts+1 WHERE id=$1 AND attempts<$2 AND used_at IS NULL RETURNING id",
    [row.id, MAX_ATTEMPTS],
  );
  if (!counted.length) return null;
  const given = Buffer.from(hashCode(row.id, normalise(typed))),
    wanted = Buffer.from(row.code_hash);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    return null;
  const used = await db.query(
    "UPDATE email_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id",
    [row.id],
  );
  return used.length ? (row.email as string) : null;
}

const cooldownSql = (purpose: Purpose) =>
  `SELECT 1 FROM email_codes WHERE user_id=$1 AND purpose='${purpose}' AND created_at > now() - ($2::int * interval '1 millisecond')`;

export async function recoveryRoutes(
  app: FastifyInstance,
  { db, hub, mailer }: Services,
  options: { cooldownMs?: number } = {},
) {
  const cooldownMs = options.cooldownMs ?? 60000;
  const needMail = () => {
    if (!mailer.enabled)
      fail(
        "email_unavailable",
        "This server hasn't set up email yet. Ask its administrator.",
        503,
      );
  };
  /** Best-effort notice; never blocks or fails the request that triggered it. */
  const notify = (to: string, subject: string, text: string) =>
    void mailer
      .send({ to, subject, text })
      .catch((e) => app.log.error({ err: e?.message }, "Notice email failed"));

  app.get("/v1/account/email", async (req) => {
    const [user] = await db.query("SELECT email FROM users WHERE id=$1", [
      req.identity.uid,
    ]);
    const [pending] = await db.query(
      "SELECT email FROM email_codes WHERE user_id=$1 AND purpose='verify' AND used_at IS NULL AND expires_at>now() AND attempts<$2 ORDER BY created_at DESC LIMIT 1",
      [req.identity.uid, MAX_ATTEMPTS],
    );
    return {
      available: mailer.enabled,
      email: (user?.email as string | null) ?? null,
      pending: (pending?.email as string | undefined) ?? null,
    };
  });

  // Step 1 of linking: prove it is you (password), then prove the mailbox is yours (code).
  app.post(
    "/v1/account/email",
    { config: { rateLimit: { max: 8, timeWindow: "1 hour" } } },
    async (req) => {
      needMail();
      const data = body(
        req,
        z.object({ email: address, password: z.string().max(128) }),
      );
      const [user] = await db.query(
        "SELECT password_hash,email FROM users WHERE id=$1",
        [req.identity.uid],
      );
      if (!(await verify(user.password_hash, data.password)))
        fail("invalid_credentials", "Password is incorrect.", 401);
      if (user.email && user.email.toLowerCase() === data.email)
        fail(
          "already_linked",
          "That email is already linked to your account.",
          409,
        );
      if (
        (await db.query(cooldownSql("verify"), [req.identity.uid, cooldownMs]))
          .length
      )
        fail(
          "slow_down",
          "A code was just sent. Wait a minute before asking for another.",
          429,
        );
      const { code, rowId } = await issueCode(
        db,
        req.identity.uid,
        "verify",
        data.email,
      );
      try {
        await mailer.send({
          to: data.email,
          subject: "Your WIISB Chat verification code",
          text: `Your WIISB Chat verification code is ${pretty(code)}.\n\nIt works for 15 minutes. Enter it in the app to link this email to your account, so you can reset your password if you ever forget it.\n\nIf you didn't ask for this, you can ignore this email. Nothing will be linked.`,
        });
      } catch (e: any) {
        await db.query("UPDATE email_codes SET used_at=now() WHERE id=$1", [
          rowId,
        ]);
        app.log.error({ err: e?.message }, "Verification email failed");
        fail(
          "email_failed",
          "We couldn't send that email. Check the address and try again.",
          502,
        );
      }
      return { ok: true, pending: data.email };
    },
  );

  // Step 2 of linking. The address is only stored here, once the code has come back.
  app.post(
    "/v1/account/email/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req) => {
      const { code } = body(req, z.object({ code: codeInput }));
      const linked = await consumeCode(db, req.identity.uid, "verify", code);
      if (!linked) fail("invalid_code", BAD_CODE, 400);
      try {
        await db.query("UPDATE users SET email=$1 WHERE id=$2", [
          linked,
          req.identity.uid,
        ]);
      } catch (e: any) {
        if ((e?.code || e?.cause?.code) === "23505")
          fail(
            "email_in_use",
            "That email is already linked to another account.",
            409,
          );
        throw e;
      }
      return { ok: true, email: linked };
    },
  );

  app.delete(
    "/v1/account/email",
    { config: { rateLimit: { max: 8, timeWindow: "1 hour" } } },
    async (req) => {
      const { password } = body(
        req,
        z.object({ password: z.string().max(128) }),
      );
      const [user] = await db.query(
        "SELECT password_hash,email FROM users WHERE id=$1",
        [req.identity.uid],
      );
      if (!(await verify(user.password_hash, password)))
        fail("invalid_credentials", "Password is incorrect.", 401);
      await db.query("UPDATE users SET email=NULL WHERE id=$1", [
        req.identity.uid,
      ]);
      await db.query(
        "UPDATE email_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
        [req.identity.uid],
      );
      if (user.email && mailer.enabled)
        notify(
          user.email,
          "Your email was unlinked from WIISB Chat",
          "This email address was removed from a WIISB Chat account, so it can no longer be used to reset that account's password.\n\nIf this wasn't you, change your password right away.",
        );
      return { ok: true };
    },
  );

  // Always answers the same way, whether or not the address belongs to an account.
  app.post(
    "/v1/auth/forgot",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req) => {
      const { email } = body(req, z.object({ email: address }));
      needMail();
      const [user] = await db.query(
        "SELECT id FROM users WHERE lower(email)=$1 AND NOT suspended",
        [email],
      );
      if (
        user &&
        !(await db.query(cooldownSql("reset"), [user.id, cooldownMs])).length
      ) {
        const { code } = await issueCode(db, user.id, "reset", email);
        notify(
          email,
          "Reset your WIISB Chat password",
          `Your WIISB Chat password reset code is ${pretty(code)}.\n\nIt works for 15 minutes and can be used once. Enter it in the app along with your new password.\n\nIf you didn't ask for this, ignore this email. Your password has not changed, and nobody can use this code without access to this mailbox.`,
        );
      }
      return {
        ok: true,
        message: "If that email is linked to an account, a code is on its way.",
      };
    },
  );

  app.post(
    "/v1/auth/reset",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req) => {
      const data = body(
        req,
        z.object({ email: address, code: codeInput, password: newPassword }),
      );
      needMail();
      const [user] = await db.query(
        "SELECT id FROM users WHERE lower(email)=$1 AND NOT suspended",
        [data.email],
      );
      const sentTo = user
        ? await consumeCode(db, user.id, "reset", data.code)
        : null;
      if (!user || !sentTo || sentTo !== data.email)
        fail("invalid_code", BAD_CODE, 400);
      const pw = await passwordHash(data.password);
      await db.transaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          pw,
          user.id,
        ]);
        await tx.query(
          "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
          [user.id],
        );
        await tx.query(
          "UPDATE email_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
          [user.id],
        );
      });
      hub.closeUser(user.id);
      notify(
        data.email,
        "Your WIISB Chat password was changed",
        "Your WIISB Chat password was just reset using an emailed code, and you were signed out everywhere.\n\nIf this wasn't you, reset it again right away and consider changing your email password.",
      );
      return { ok: true };
    },
  );
}
