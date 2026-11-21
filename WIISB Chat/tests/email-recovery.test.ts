import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import type { Mail, Mailer } from "../apps/server/src/mail.js";

const inbox: Mail[] = [];
const mailer: Mailer = {
  enabled: true,
  send: async (m) => void inbox.push(m),
};
/** The newest message to an address; its 8-character code is what the person would read. */
const latest = (to: string) => inbox.filter((m) => m.to === to).at(-1);
const codeIn = (m?: Mail) =>
  m?.text.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)?.[1] ?? "";
const settle = () => new Promise((r) => setTimeout(r, 60)); // notices are sent in the background

test("email linking and forgotten-password recovery", async (t) => {
  await mkdir("test-results", { recursive: true });
  const directory = await mkdtemp(resolve("test-results/email-"));
  const server = await createApp({
    dataDir: directory,
    mailer,
    mailCooldownMs: 0,
  });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${(server.app.server.address() as any).port}`;
  const request = async (
    method: string,
    path: string,
    token?: string,
    data?: any,
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const register = async (username: string, password: string) =>
    (
      await request("POST", "/v1/auth/register", undefined, {
        username,
        password,
      })
    ).body;
  try {
    const alice = await register("alice", "alice-password-123");
    const bob = await register("bobby", "bobby-password-123");
    assert.ok(alice.access && bob.access);

    await t.test("the server says email recovery is available", async () => {
      const info = (await request("GET", "/v1/info")).body;
      assert.equal(info.emailRecovery, true);
    });

    await t.test("linking needs sign-in and the current password", async () => {
      assert.equal((await request("GET", "/v1/account/email")).status, 401);
      assert.equal(
        (
          await request("POST", "/v1/account/email", undefined, {
            email: "a@example.com",
            password: "x",
          })
        ).status,
        401,
      );
      const wrong = await request("POST", "/v1/account/email", alice.access, {
        email: "alice@example.com",
        password: "not-my-password",
      });
      assert.equal(wrong.status, 401);
      assert.equal(
        inbox.length,
        0,
        "no email may be sent for a wrong password",
      );
      const bad = await request("POST", "/v1/account/email", alice.access, {
        email: "not-an-email",
        password: "alice-password-123",
      });
      assert.equal(bad.status, 400);
    });

    await t.test(
      "an address is only linked after its code comes back",
      async () => {
        const sent = await request("POST", "/v1/account/email", alice.access, {
          email: "Alice@Example.com ",
          password: "alice-password-123",
        });
        assert.equal(sent.status, 200, sent.body.message);
        const mail = latest("alice@example.com");
        assert.ok(
          mail,
          "a verification email was sent to the lower-cased address",
        );
        const state = (await request("GET", "/v1/account/email", alice.access))
          .body;
        assert.equal(state.email, null, "not linked yet");
        assert.equal(state.pending, "alice@example.com");
        const [row] = await server.db.query(
          "SELECT email FROM users WHERE username='alice'",
        );
        assert.equal(row.email, null);

        const wrong = await request(
          "POST",
          "/v1/account/email/verify",
          alice.access,
          { code: "AAAA-AAAA" },
        );
        assert.equal(wrong.status, 400);
        assert.equal(wrong.body.code, "invalid_code");
        const typed = codeIn(mail).toLowerCase().replace("-", " "); // people type it loosely
        const ok = await request(
          "POST",
          "/v1/account/email/verify",
          alice.access,
          { code: typed },
        );
        assert.equal(ok.status, 200, ok.body.message);
        assert.equal(
          (await request("GET", "/v1/account/email", alice.access)).body.email,
          "alice@example.com",
        );
      },
    );

    await t.test(
      "only a salted hash of a code is stored, and a code works once",
      async () => {
        await request("POST", "/v1/account/email", bob.access, {
          email: "bob@example.com",
          password: "bobby-password-123",
        });
        const code = codeIn(latest("bob@example.com"));
        const rows = await server.db.query("SELECT code_hash FROM email_codes");
        assert.ok(rows.length >= 2);
        assert.ok(
          rows.every((r) => !r.code_hash.includes(code.replace("-", ""))),
        );
        assert.equal(
          (
            await request("POST", "/v1/account/email/verify", bob.access, {
              code,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request("POST", "/v1/account/email/verify", bob.access, {
              code,
            })
          ).status,
          400,
          "second use fails",
        );
      },
    );

    await t.test("an address cannot be linked to two accounts", async () => {
      const carol = await register("carol", "carol-password-123");
      await request("POST", "/v1/account/email", carol.access, {
        email: "alice@example.com",
        password: "carol-password-123",
      });
      const verify = await request(
        "POST",
        "/v1/account/email/verify",
        carol.access,
        {
          code: codeIn(latest("alice@example.com")),
        },
      );
      assert.equal(verify.status, 409);
      assert.equal(verify.body.code, "email_in_use");
    });

    await t.test(
      "asking to reset never reveals whether an address has an account",
      async () => {
        const before = inbox.length;
        const unknown = await request("POST", "/v1/auth/forgot", undefined, {
          email: "nobody@example.com",
        });
        const known = await request("POST", "/v1/auth/forgot", undefined, {
          email: "ALICE@example.com",
        });
        assert.equal(unknown.status, 200);
        assert.equal(known.status, 200);
        assert.deepEqual(unknown.body, known.body);
        await settle();
        assert.equal(
          inbox.length,
          before + 1,
          "only the real account got an email",
        );
        assert.equal(latest("nobody@example.com"), undefined);
      },
    );

    await t.test(
      "five wrong tries lock a code even if the right one is entered next",
      async () => {
        const mail = latest("alice@example.com")!;
        const right = codeIn(mail);
        for (let i = 0; i < 5; i++) {
          const r = await request("POST", "/v1/auth/reset", undefined, {
            email: "alice@example.com",
            code: "ZZZZ-ZZZZ",
            password: "a-brand-new-password",
          });
          assert.equal(r.status, 400);
        }
        const late = await request("POST", "/v1/auth/reset", undefined, {
          email: "alice@example.com",
          code: right,
          password: "a-brand-new-password",
        });
        assert.equal(
          late.status,
          400,
          "the code is dead after five wrong tries",
        );
        assert.equal(
          (
            await request("POST", "/v1/auth/login", undefined, {
              username: "alice",
              password: "a-brand-new-password",
            })
          ).status,
          401,
        );
      },
    );

    await t.test(
      "a good code resets the password and signs out every device",
      async () => {
        await request("POST", "/v1/auth/forgot", undefined, {
          email: "alice@example.com",
        });
        const fresh = latest("alice@example.com")!;
        assert.notEqual(codeIn(fresh), "");
        const tooShort = await request("POST", "/v1/auth/reset", undefined, {
          email: "alice@example.com",
          code: codeIn(fresh),
          password: "short",
        });
        assert.equal(tooShort.status, 400, "a weak password is refused");
        const done = await request("POST", "/v1/auth/reset", undefined, {
          email: "alice@example.com",
          code: codeIn(fresh),
          password: "a-brand-new-password",
        });
        assert.equal(done.status, 200, done.body.message);
        assert.equal(
          (await request("GET", "/v1/sessions", alice.access)).status,
          401,
          "old session is revoked",
        );
        assert.equal(
          (
            await request("POST", "/v1/auth/refresh", undefined, {
              refresh: alice.refresh,
            })
          ).status,
          401,
          "old refresh token is revoked",
        );
        assert.equal(
          (
            await request("POST", "/v1/auth/login", undefined, {
              username: "alice",
              password: "alice-password-123",
            })
          ).status,
          401,
        );
        const login = await request("POST", "/v1/auth/login", undefined, {
          username: "alice",
          password: "a-brand-new-password",
        });
        assert.equal(login.status, 200);
        alice.access = login.body.access;
        await settle();
        assert.match(
          latest("alice@example.com")!.subject,
          /password was changed/i,
        );
        const reuse = await request("POST", "/v1/auth/reset", undefined, {
          email: "alice@example.com",
          code: codeIn(fresh),
          password: "another-new-password-1",
        });
        assert.equal(reuse.status, 400, "a used code cannot be used again");
      },
    );

    await t.test("a code for one account cannot reset another", async () => {
      await request("POST", "/v1/auth/forgot", undefined, {
        email: "alice@example.com",
      });
      const aliceCode = codeIn(latest("alice@example.com"));
      const cross = await request("POST", "/v1/auth/reset", undefined, {
        email: "bob@example.com",
        code: aliceCode,
        password: "hijacked-password-1",
      });
      assert.equal(cross.status, 400);
    });

    await t.test(
      "unlinking needs the password and stops recovery",
      async () => {
        assert.equal(
          (
            await request("DELETE", "/v1/account/email", alice.access, {
              password: "nope",
            })
          ).status,
          401,
        );
        const gone = await request(
          "DELETE",
          "/v1/account/email",
          alice.access,
          { password: "a-brand-new-password" },
        );
        assert.equal(gone.status, 200);
        assert.equal(
          (await request("GET", "/v1/account/email", alice.access)).body.email,
          null,
        );
        await settle();
        assert.match(
          latest("alice@example.com")!.subject,
          /unlinked/i,
          "the old address is told it was unlinked",
        );
        const before = inbox.length;
        assert.equal(
          (
            await request("POST", "/v1/auth/forgot", undefined, {
              email: "alice@example.com",
            })
          ).status,
          200,
        );
        await settle();
        assert.equal(
          inbox.length,
          before,
          "no reset code is sent to an address that is no longer linked",
        );
      },
    );

    await t.test("a suspended account cannot be recovered into", async () => {
      await server.db.query(
        "UPDATE users SET suspended=true WHERE username='bobby'",
      );
      const before = inbox.length;
      assert.equal(
        (
          await request("POST", "/v1/auth/forgot", undefined, {
            email: "bob@example.com",
          })
        ).status,
        200,
      );
      await settle();
      assert.equal(inbox.length, before);
    });
  } finally {
    await server.app.close();
  }
});

test("a server without email says so and sends nothing", async () => {
  await mkdir("test-results", { recursive: true });
  const directory = await mkdtemp(resolve("test-results/noemail-"));
  const sent: Mail[] = [];
  const server = await createApp({
    dataDir: directory,
    mailer: { enabled: false, send: async (m) => void sent.push(m) },
  });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${(server.app.server.address() as any).port}`;
  try {
    const info = await (await fetch(origin + "/v1/info")).json();
    assert.equal(info.emailRecovery, false);
    const res = await fetch(origin + "/v1/auth/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com" }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "email_unavailable");
    assert.equal(sent.length, 0);
  } finally {
    await server.app.close();
  }
});
