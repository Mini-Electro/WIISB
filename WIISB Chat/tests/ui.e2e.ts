import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
process.env.LIVEKIT_URL = "ws://127.0.0.1:7880";
process.env.LIVEKIT_INTERNAL_URL = "http://127.0.0.1:7880";
process.env.LIVEKIT_API_KEY = "devkey";
process.env.LIVEKIT_API_SECRET = "secret";
const { createApp } = await import("../apps/server/src/app.js");
await mkdir("test-results", { recursive: true });
const directory = await mkdtemp(resolve("test-results/ui-db-"));
const server = await createApp({ dataDir: directory, logger: true });
await server.app.listen({ port: 4310, host: "127.0.0.1" });
const vite = await createServer({
  root: resolve("apps/desktop"),
  configFile: resolve("apps/desktop/vite.config.ts"),
});
await vite.listen();
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const a = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone", "camera"],
  }),
  b = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone", "camera"],
  });
const ap = await a.newPage(),
  bp = await b.newPage(),
  errors: string[] = [];
for (const page of [ap, bp])
  page.on("pageerror", (e) => errors.push(e.message));
const results: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  console.log("START", name);
  await fn();
  results.push(name);
  console.log("PASS", name);
}
async function register(page: Page, username: string, display: string) {
  await page.goto("http://127.0.0.1:1432");
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Display name", { exact: true }).fill(display);
  await page
    .getByLabel("Password", { exact: true })
    .fill("ui-test-password-123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Friends", exact: true }),
  ).toBeVisible();
}
try {
  await step("Two users register through the actual UI", async () => {
    await register(ap, "ui_alice", "Alice UI");
    await register(bp, "ui_bob", "Bob UI");
  });
  await step("Friend requests and acceptance update both clients", async () => {
    await ap.getByRole("button", { name: "Add friend", exact: true }).click();
    await ap
      .getByRole("dialog")
      .getByLabel("Username", { exact: true })
      .fill("ui_bob");
    await ap
      .getByRole("button", { name: "Send friend request", exact: true })
      .click();
    await expect(ap.getByText("Friend request sent.")).toBeVisible();
    await ap.getByRole("button", { name: "Close dialog", exact: true }).click();
    await bp.getByRole("button", { name: /^Pending/ }).click();
    await bp.getByRole("button", { name: "Accept friend request" }).click();
    await ap.getByRole("button", { name: "All", exact: true }).click();
    await expect(
      ap.getByText("Alice UI", { exact: true }).first(),
    ).toBeVisible();
    await expect(ap.getByText("Bob UI", { exact: true }).first()).toBeVisible();
  });
  await step("UI messages deliver live in both directions", async () => {
    await ap.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(ap.getByLabel("Message", { exact: true })).toBeVisible();
    await ap
      .getByLabel("Message", { exact: true })
      .fill("Hello Bob from the real client");
    await ap.getByLabel("Message", { exact: true }).press("Enter");
    await bp.getByRole("button", { name: "All", exact: true }).click();
    await bp.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      bp.getByText("Hello Bob from the real client", { exact: true }),
    ).toBeVisible();
    await bp
      .getByLabel("Message", { exact: true })
      .fill("Hello Alice, received in real time");
    await bp.getByLabel("Message", { exact: true }).press("Enter");
    await expect(
      ap.getByText("Hello Alice, received in real time", { exact: true }),
    ).toBeVisible();
  });
  await step("Profile changes and theme previews work", async () => {
    await ap.getByRole("button", { name: "User settings (Ctrl+,)" }).click();
    await ap
      .getByLabel("Custom status", { exact: true })
      .fill("Testing a real connection");
    await ap.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(ap.getByText("Profile saved.")).toBeVisible();
    await ap.getByRole("button", { name: "Appearance", exact: true }).click();
    await ap.getByRole("button", { name: "Neon Blue", exact: true }).click();
    await expect(ap.locator("html")).toHaveAttribute(
      "style",
      /--accent: #38bdf8/,
    );
    await ap
      .getByRole("button", { name: "Midnight Purple", exact: true })
      .click();
    await ap.getByRole("button", { name: "Close dialog", exact: true }).click();
  });
  await step(
    "Two clients join a real LiveKit room and receive synthetic media tracks",
    async () => {
      await ap
        .getByRole("button", { name: "Start voice or video call" })
        .click();
      await bp
        .getByRole("button", { name: "Start voice or video call" })
        .click();
      await expect(ap.locator(".call-panel")).toContainText("connected", {
        timeout: 20000,
      });
      await expect(bp.locator(".call-panel")).toContainText("connected", {
        timeout: 20000,
      });
      await expect(ap.locator(".participant")).toHaveCount(2, {
        timeout: 20000,
      });
      await expect(bp.locator(".participant")).toHaveCount(2, {
        timeout: 20000,
      });
      await ap
        .getByRole("button", { name: "Turn camera on", exact: true })
        .click();
      await expect(bp.locator(".participant video")).toHaveCount(1, {
        timeout: 20000,
      });
      await expect
        .poll(
          () =>
            bp
              .locator(".participant video")
              .evaluate((el: HTMLVideoElement) => el.videoWidth),
          { timeout: 20000 },
        )
        .toBeGreaterThan(0);
      await bp
        .getByRole("button", { name: "Deafen call audio", exact: true })
        .click();
      await expect
        .poll(() =>
          bp
            .locator(".participant audio")
            .evaluateAll(
              (elements) =>
                elements.length > 0 && elements.every((el: any) => el.muted),
            ),
        )
        .toBe(true);
      await bp
        .getByRole("button", { name: "Enable call audio", exact: true })
        .click();
      await ap
        .getByRole("button", { name: "Mute microphone", exact: true })
        .click();
      await expect(
        ap.getByRole("button", { name: "Unmute microphone", exact: true }),
      ).toBeVisible();
      await bp.screenshot({ path: resolve("test-results/live-media.png") });
      await ap
        .getByRole("button", { name: "Disconnect call", exact: true })
        .click();
      await bp
        .getByRole("button", { name: "Disconnect call", exact: true })
        .click();
    },
  );
  await step(
    "Community creation, channel navigation and invitation preview work",
    async () => {
      await ap
        .getByRole("button", { name: "Create or join a community" })
        .click();
      await ap
        .getByLabel("Community name", { exact: true })
        .fill("UI community");
      await ap
        .getByRole("button", { name: "Create community", exact: true })
        .click();
      await expect(
        ap.getByRole("heading", { name: "general", exact: true }),
      ).toBeVisible();
      await ap
        .getByLabel("Message", { exact: true })
        .fill("A real community message");
      await ap.getByLabel("Message", { exact: true }).press("Enter");
      await expect(
        ap.getByText("A real community message", { exact: true }),
      ).toBeVisible();
      await ap
        .getByRole("button", { name: "UI community", exact: true })
        .click();
      await ap.getByRole("button", { name: "Invites", exact: true }).click();
      await ap
        .getByRole("button", { name: "Create invitation", exact: true })
        .click();
      const token = await ap.locator(".invite-code code").innerText();
      await ap
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await bp
        .getByRole("button", { name: "Create or join a community" })
        .click();
      await bp
        .getByRole("button", { name: "Join with an invite", exact: true })
        .click();
      await bp.getByLabel("Invitation code", { exact: true }).fill(token);
      await bp
        .getByRole("button", { name: "Preview invitation", exact: true })
        .click();
      await expect(bp.locator(".invite-preview")).toContainText("UI community");
      await bp
        .getByRole("button", { name: "Join community", exact: true })
        .click();
      await expect(
        bp.getByText("A real community message", { exact: true }),
      ).toBeVisible();
      await bp.screenshot({ path: resolve("test-results/community.png") });
    },
  );
  await step(
    "Small desktop layout and keyboard switcher remain usable",
    async () => {
      await ap.setViewportSize({ width: 1024, height: 720 });
      await expect(ap.getByLabel("Message", { exact: true })).toBeVisible();
      await ap.keyboard.press("Control+k");
      await expect(ap.getByRole("dialog", { name: "Where to?" })).toBeVisible();
      await ap.keyboard.press("Escape");
      await ap.screenshot({ path: resolve("test-results/desktop-1024.png") });
    },
  );
  expect(errors).toEqual([]);
  await writeFile(
    resolve("test-results/ui-results.json"),
    JSON.stringify(
      {
        passed: results,
        errors,
        media:
          "Synthetic camera/microphone tracks over real local LiveKit; physical devices, native screen capture and WAN not verified.",
      },
      null,
      2,
    ),
  );
} catch (e) {
  await ap.screenshot({ path: resolve("test-results/ui-failure-alice.png") });
  await bp.screenshot({ path: resolve("test-results/ui-failure-bob.png") });
  throw e;
} finally {
  await browser.close();
  await vite.close();
  await server.app.close();
}
