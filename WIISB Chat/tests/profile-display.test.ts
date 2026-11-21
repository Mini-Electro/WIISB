import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../apps/server/src/app.js";

test("avatar and banner framing (zoom, position, banner height)", async (t) => {
  await mkdir("test-results", { recursive: true });
  const directory = await mkdtemp(resolve("test-results/profile-"));
  const server = await createApp({ dataDir: directory });
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
  const register = async (username: string) =>
    (
      await request("POST", "/v1/auth/register", undefined, {
        username,
        password: username + "-password-123",
      })
    ).body;
  try {
    const alice = await register("alice");
    const bob = await register("bobby");
    assert.ok(alice.access && bob.access);

    await t.test("a new profile starts centred at normal size", async () => {
      const me = (await request("GET", "/v1/me", alice.access)).body;
      assert.deepEqual(
        [me.avatar_zoom, me.avatar_x, me.avatar_y, me.banner_zoom, me.banner_x, me.banner_y, me.banner_height],
        [1, 50, 50, 1, 50, 50, 100],
      );
    });

    await t.test("framing is saved and other people see it", async () => {
      const saved = await request("PATCH", "/v1/me", alice.access, {
        avatar_zoom: 2.5,
        avatar_x: 20,
        avatar_y: 80,
        banner_zoom: 1.5,
        banner_x: 70,
        banner_y: 30,
        banner_height: 160,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(
        [saved.body.avatar_zoom, saved.body.avatar_x, saved.body.avatar_y, saved.body.banner_zoom, saved.body.banner_x, saved.body.banner_y, saved.body.banner_height],
        [2.5, 20, 80, 1.5, 70, 30, 160],
      );
      const me = (await request("GET", "/v1/me", alice.access)).body;
      assert.equal(me.banner_height, 160);
      const profile = (await request("GET", "/v1/users/" + me.id, bob.access)).body;
      assert.equal(profile.avatar_zoom, 2.5);
      assert.equal(profile.banner_height, 160);
    });

    await t.test("values outside the allowed range are refused and change nothing", async () => {
      for (const bad of [
        { avatar_zoom: 0.5 },
        { avatar_zoom: 9 },
        { avatar_x: -1 },
        { banner_y: 101 },
        { banner_height: 10 },
        { banner_height: 999 },
        { banner_zoom: "big" },
      ]) {
        const r = await request("PATCH", "/v1/me", alice.access, bad);
        assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(bad) + " -> " + r.status);
      }
      const me = (await request("GET", "/v1/me", alice.access)).body;
      assert.equal(me.avatar_zoom, 2.5);
      assert.equal(me.banner_height, 160);
    });

    await t.test("the bio is still saved with the framing", async () => {
      const r = await request("PATCH", "/v1/me", alice.access, { bio: "Hello there", banner_height: 120 });
      assert.equal(r.status, 200);
      assert.equal(r.body.bio, "Hello there");
      assert.equal(r.body.banner_height, 120);
    });
  } finally {
    await server.app.close();
  }
});
