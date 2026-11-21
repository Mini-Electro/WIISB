import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import sharp from "sharp";
import { createApp } from "../apps/server/src/app.js";
import { collectStorage } from "../apps/server/src/cleanup.js";

test("two-user network, persistence and authorization integration", async (t) => {
  await mkdir("test-results", { recursive: true });
  const directory = await mkdtemp(resolve("test-results/db-"));
  let server = await createApp({ dataDir: directory, logger: true });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  let origin = `http://127.0.0.1:${(server.app.server.address() as any).port}`;
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
    const body = await response.json();
    return { status: response.status, body };
  };
  let a: any,
    b: any,
    c: any,
    channel: any,
    community: any,
    mid: string = "",
    group: any,
    privateChannel: any;
  const sockets: WebSocket[] = [];
  try {
    await t.test(
      "registration, Argon2 password storage and unauthorized rejection",
      async () => {
        a = (
          await request("POST", "/v1/auth/register", undefined, {
            username: "alice",
            displayName: "Alice",
            password: "alice-password-123",
          })
        ).body;
        b = (
          await request("POST", "/v1/auth/register", undefined, {
            username: "bob",
            displayName: "Bob",
            password: "bob-password-123",
          })
        ).body;
        c = (
          await request("POST", "/v1/auth/register", undefined, {
            username: "outsider",
            password: "outside-password-123",
          })
        ).body;
        assert.ok(a.access, a.message);
        assert.ok(b.access, b.message);
        assert.equal((await request("GET", "/v1/me")).status, 401);
        assert.equal(
          (
            await request("POST", "/v1/auth/register", undefined, {
              username: "alice",
              password: "alice-password-123",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await request("POST", "/v1/auth/login", undefined, {
              username: "alice",
              password: "wrong-password",
            })
          ).status,
          401,
        );
        const [row] = await server.db.query(
          "SELECT password_hash FROM users WHERE id=$1",
          [a.user.id],
        );
        assert.match(row.password_hash, /^\$argon2id\$/);
      },
    );
    await t.test(
      "friend request lifecycle, duplicate requests and real DM creation",
      async () => {
        assert.equal(
          (await request("POST", "/v1/friends", a.access, { username: "bob" }))
            .status,
          200,
        );
        await request("POST", "/v1/friends", a.access, { username: "bob" });
        assert.equal(
          (await request("GET", "/v1/friends", b.access)).body.incoming.length,
          1,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/friends/${a.user.id}/accept`,
              b.access,
              {},
            )
          ).status,
          200,
        );
        assert.equal(
          (await request("GET", "/v1/friends", a.access)).body.friends.length,
          1,
        );
        channel = (
          await request("POST", "/v1/conversations", a.access, {
            users: [b.user.id],
          })
        ).body;
        assert.ok(channel.id, channel.message);
        assert.equal(
          (
            await request("POST", "/v1/conversations", b.access, {
              users: [a.user.id],
            })
          ).body.id,
          channel.id,
        );
      },
    );
    await t.test(
      "two authenticated WebSocket clients receive real events, and dedupe survives retries",
      async () => {
        async function socket(token: string) {
          const ticket = (
            await request("POST", "/v1/realtime-ticket", token, {})
          ).body.ticket;
          const ws = new WebSocket(
            origin.replace("http:", "ws:") + "/v1/events?ticket=" + ticket,
          );
          sockets.push(ws);
          await new Promise<void>((res, rej) => {
            ws.once("open", res);
            ws.once("error", rej);
          });
          return ws;
        }
        const aw = await socket(a.access),
          bw = await socket(b.access);
        const event = new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("No realtime message")),
            5000,
          );
          bw.on("message", (raw) => {
            const e = JSON.parse(raw.toString());
            if (e.type === "message.created") {
              clearTimeout(timeout);
              resolve(e);
            }
          });
        });
        const nonce = randomUUID(),
          data = { content: "Hello over a real network socket", nonce };
        const sent = await request(
          "POST",
          `/v1/channels/${channel.id}/messages`,
          a.access,
          data,
        );
        assert.equal(sent.status, 200, sent.body.message);
        mid = sent.body.id;
        assert.equal((await event).payload.id, mid);
        assert.equal(
          (
            await request(
              "POST",
              `/v1/channels/${channel.id}/messages`,
              a.access,
              data,
            )
          ).body.id,
          mid,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${channel.id}/messages`,
              b.access,
            )
          ).body.messages.length,
          1,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${channel.id}/messages`,
              c.access,
            )
          ).status,
          403,
        );
        const reply = await request(
          "POST",
          `/v1/channels/${channel.id}/messages`,
          b.access,
          {
            content: "A real reply from Bob",
            nonce: randomUUID(),
            replyId: mid,
          },
        );
        assert.equal(reply.status, 200, reply.body.message);
        assert.equal(reply.body.reply.id, mid);
      },
    );
    await t.test(
      "edits, reactions, read state and search enforce access",
      async () => {
        assert.equal(
          (
            await request("PATCH", `/v1/messages/${mid}`, b.access, {
              content: "stolen",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("PATCH", `/v1/messages/${mid}`, a.access, {
              content: "Edited message with constellation",
            })
          ).body.content,
          "Edited message with constellation",
        );
        for (let n = 0; n < 2; n++)
          await request("PUT", `/v1/messages/${mid}/reactions`, b.access, {
            emoji: "✨",
            active: true,
          });
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${channel.id}/messages`,
              a.access,
            )
          ).body.messages[0].reactions[0].users.length,
          1,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/search?channelId=${channel.id}&q=constellation`,
              b.access,
            )
          ).body.length,
          1,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/search?channelId=${channel.id}&q=constellation`,
              c.access,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/channels/${channel.id}/read`,
              b.access,
              {},
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "community creation, transactional invitations, channels and private roles",
      async () => {
        community = (
          await request("POST", "/v1/servers", a.access, {
            name: "Test community",
          })
        ).body;
        assert.ok(community.id, community.message);
        const invite = (
          await request(
            "POST",
            `/v1/servers/${community.id}/invites`,
            a.access,
            { maxUses: 1 },
          )
        ).body;
        assert.equal(
          (
            await request(
              "POST",
              `/v1/invites/${invite.token}/join`,
              b.access,
              {},
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/invites/${invite.token}/join`,
              c.access,
              {},
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/servers/${community.id}/channels`,
              b.access,
              { name: "not-allowed" },
            )
          ).status,
          403,
        );
        const role = (
          await request("POST", `/v1/servers/${community.id}/roles`, a.access, {
            name: "Private team",
            color: "#a78bfa",
            position: 10,
            permissions: ["view", "send"],
          })
        ).body;
        privateChannel = (
          await request(
            "POST",
            `/v1/servers/${community.id}/channels`,
            a.access,
            { name: "private-team", private: true, allowed_roles: [role.id] },
          )
        ).body;
        assert.ok(privateChannel.id, privateChannel.message);
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${privateChannel.id}/messages`,
              b.access,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "PUT",
              `/v1/servers/${community.id}/members/${b.user.id}/roles`,
              a.access,
              { roles: [role.id] },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${privateChannel.id}/messages`,
              b.access,
            )
          ).status,
          200,
        );
        const text = (
          await request("GET", `/v1/servers/${community.id}`, b.access)
        ).body.channels.find((ch: any) => ch.kind === "text" && !ch.private);
        assert.equal(
          (
            await request(
              "POST",
              `/v1/channels/${text.id}/messages`,
              b.access,
              { content: "Server message", nonce: randomUUID() },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/voice/${privateChannel.id}/token`,
              c.access,
              {},
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "actual image upload, authenticated retrieval, traversal names and deleted media",
      async () => {
        const buffer = await sharp({
          create: { width: 20, height: 20, channels: 4, background: "#8b5cf6" },
        })
          .png()
          .toBuffer();
        const form = new FormData();
        form.append(
          "file",
          new Blob([buffer], { type: "image/png" }),
          "../../image.png",
        );
        const res = await fetch(
          origin + `/v1/channels/${channel.id}/attachments`,
          {
            method: "POST",
            headers: { Authorization: "Bearer " + a.access },
            body: form,
          },
        );
        const asset = (await res.json()) as any;
        assert.equal(res.status, 200, asset.message);
        assert.equal(asset.name, "image.png");
        assert.equal(
          (
            await fetch(origin + `/v1/attachments/${asset.id}`, {
              headers: { Authorization: "Bearer " + b.access },
            })
          ).status,
          403,
        );
        const m = (
          await request(
            "POST",
            `/v1/channels/${channel.id}/messages`,
            a.access,
            { content: "Image", nonce: randomUUID(), attachments: [asset.id] },
          )
        ).body;
        assert.ok(m.id, m.message);
        const image = await fetch(origin + `/v1/attachments/${asset.id}`, {
          headers: { Authorization: "Bearer " + b.access },
        });
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("content-type"), "image/png");
        assert.equal(
          (
            await fetch(origin + `/v1/attachments/${asset.id}`, {
              headers: { Authorization: "Bearer " + c.access },
            })
          ).status,
          403,
        );
        await request("DELETE", `/v1/messages/${m.id}`, a.access);
        assert.equal(
          (
            await fetch(origin + `/v1/attachments/${asset.id}`, {
              headers: { Authorization: "Bearer " + b.access },
            })
          ).status,
          404,
        );
        const bad = new FormData();
        bad.append(
          "file",
          new Blob(['<svg onload="alert(1)"></svg>'], { type: "image/png" }),
          "fake.png",
        );
        assert.equal(
          (
            await fetch(origin + `/v1/channels/${channel.id}/attachments`, {
              method: "POST",
              headers: { Authorization: "Bearer " + a.access },
              body: bad,
            })
          ).status,
          415,
        );
      },
    );
    await t.test(
      "block prevents new messages and requests; unblocking restores eligible communication",
      async () => {
        await request("POST", `/v1/blocks/${a.user.id}`, b.access, {});
        assert.equal(
          (await request("POST", "/v1/friends", a.access, { username: "bob" }))
            .status,
          400,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/channels/${channel.id}/messages`,
              a.access,
              { content: "blocked", nonce: randomUUID() },
            )
          ).status,
          403,
        );
        await request("DELETE", `/v1/blocks/${a.user.id}`, b.access);
        await request("POST", "/v1/friends", a.access, { username: "bob" });
        await request("POST", `/v1/friends/${a.user.id}/accept`, b.access, {});
      },
    );
    await t.test(
      "group owners control membership and removed users lose access",
      async () => {
        group = (
          await request("POST", "/v1/conversations", a.access, {
            users: [b.user.id],
            name: "Two-person group",
          })
        ).body;
        assert.equal(group.kind, "group");
        assert.equal(
          (
            await request("PATCH", "/v1/conversations/" + group.id, b.access, {
              name: "Takeover",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("PATCH", "/v1/conversations/" + group.id, a.access, {
              remove: b.user.id,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request("GET", `/v1/channels/${group.id}/messages`, b.access))
            .status,
          403,
        );
      },
    );
    await t.test(
      "role hierarchy rejects privilege escalation and kicks revoke channel access",
      async () => {
        const role = (
          await request("POST", `/v1/servers/${community.id}/roles`, a.access, {
            name: "Junior manager",
            color: "#a78bfa",
            position: 20,
            permissions: ["view", "send", "manage_roles"],
          })
        ).body;
        assert.equal(
          (
            await request(
              "PUT",
              `/v1/servers/${community.id}/members/${b.user.id}/roles`,
              a.access,
              { roles: [role.id] },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "POST",
              `/v1/servers/${community.id}/roles`,
              b.access,
              {
                name: "Escalated",
                color: "#a78bfa",
                position: 30,
                permissions: ["ban"],
              },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "PATCH",
              `/v1/servers/${community.id}/roles/${role.id}`,
              b.access,
              { permissions: ["ban"] },
            )
          ).status,
          403,
        );
        assert.equal(
          (await request("GET", `/v1/servers/${community.id}/audit`, b.access))
            .status,
          403,
        );
        const general = (
          await request("GET", `/v1/servers/${community.id}`, a.access)
        ).body.channels.find((ch: any) => ch.kind === "text" && !ch.private);
        assert.equal(
          (
            await request(
              "POST",
              `/v1/servers/${community.id}/moderation`,
              a.access,
              {
                action: "kick",
                userId: b.user.id,
                reason: "Integration verification",
              },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/v1/channels/${general.id}/messages`,
              b.access,
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "storage garbage collection removes unreferenced physical objects",
      async () => {
        const key = randomUUID();
        await server.storage.put(key, Buffer.from("orphan"), "text/plain");
        await server.db.query(
          "INSERT INTO storage_objects(key,created_at) VALUES($1,now()-interval '2 hours')",
          [key],
        );
        await collectStorage(server);
        await assert.rejects(() => server.storage.get(key));
      },
    );
    await t.test(
      "refresh rotation, replay revocation, session revocation and logout",
      async () => {
        const login = (
          await request("POST", "/v1/auth/login", undefined, {
            username: "outsider",
            password: "outside-password-123",
          })
        ).body;
        const rotated = (
          await request("POST", "/v1/auth/refresh", undefined, {
            refresh: login.refresh,
          })
        ).body;
        assert.ok(rotated.access);
        assert.equal(
          (
            await request("POST", "/v1/auth/refresh", undefined, {
              refresh: login.refresh,
            })
          ).status,
          401,
        );
        assert.equal(
          (await request("GET", "/v1/me", rotated.access)).status,
          401,
        );
        assert.equal(
          (await request("POST", "/v1/auth/logout", c.access, {})).status,
          200,
        );
        assert.equal((await request("GET", "/v1/me", c.access)).status, 401);
      },
    );
    await t.test(
      "messages persist after closing and reopening the database and network server",
      async () => {
        try {
          for (const socket of sockets) socket.terminate();
          await server.app.close().catch((e) => {
            console.error("CLOSE FAILURE", e);
            throw e;
          });
          server = await createApp({ dataDir: directory }).catch((e) => {
            console.error("REOPEN FAILURE", e);
            throw e;
          });
          await server.app.listen({ port: 0, host: "127.0.0.1" });
          origin = `http://127.0.0.1:${(server.app.server.address() as any).port}`;
          const login = (
            await request("POST", "/v1/auth/login", undefined, {
              username: "bob",
              password: "bob-password-123",
            })
          ).body;
          const history = await request(
            "GET",
            `/v1/channels/${channel.id}/messages`,
            login.access,
          );
          assert.equal(history.status, 200, history.body.message);
          assert.ok(
            history.body.messages.some(
              (m: any) => m.id === mid && m.content.includes("constellation"),
            ),
          );
        } catch (e) {
          console.error("PERSISTENCE FAILURE:", e);
          throw e;
        }
      },
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.app.close();
  }
  await writeFile(
    join(directory, "PASSED.txt"),
    "Real HTTP + WebSocket and persistent PostgreSQL integration passed.\n",
  );
});
