import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { resolve } from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import type { Mail } from "../apps/server/src/mail.js";

// Drives the real screens in headless Chromium: link an email, sign out, "Forgot password?", reset, sign in again.
const { createApp } = await import("../apps/server/src/app.js");
await mkdir("test-results", { recursive: true });
const directory = await mkdtemp(resolve("test-results/ui-recovery-db-"));
const inbox: Mail[] = [];
const server = await createApp({
  dataDir: directory,
  mailer: { enabled: true, send: async (m) => void inbox.push(m) },
  mailCooldownMs: 0,
});
await server.app.listen({ port: 4310, host: "127.0.0.1" });
const vite = await createServer({
  root: resolve("apps/desktop"),
  configFile: resolve("apps/desktop/vite.config.ts"),
});
await vite.listen();
const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name: string) =>
  page.screenshot({ path: `test-results/email-ui-${name}.png` });
const codeFrom = async (to: string) => {
  await expect.poll(() => inbox.filter((m) => m.to === to).length).toBeGreaterThan(0);
  return inbox.filter((m) => m.to === to).at(-1)!.text.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)![1];
};
const results: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  console.log("START", name);
  await fn();
  results.push(name);
  console.log("PASS", name);
}
try {
  await page.goto("http://127.0.0.1:1432");
  await step("create an account", async () => {
    await page.getByRole("button", { name: "Create an account", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("dana");
    await page.getByLabel("Display name", { exact: true }).fill("Dana");
    await page.getByLabel("Password", { exact: true }).fill("dana-first-password");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeHidden();
  });
  await step("link an email from Settings → Account", async () => {
    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Email & password reset" })).toBeVisible();
    await shot("1-settings-unlinked");
    await page.getByLabel("Email", { exact: true }).fill("dana@example.com");
    await page.getByLabel("Your password", { exact: true }).fill("dana-first-password");
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect(page.getByText("We sent a code to")).toBeVisible();
    await shot("2-settings-enter-code");
    await page.getByLabel("Code from the email", { exact: true }).fill(await codeFrom("dana@example.com"));
    await page.getByRole("button", { name: "Confirm email" }).click();
    await expect(page.getByText("Email linked.")).toBeVisible();
    await expect(page.getByText("dana@example.com")).toBeVisible();
    await shot("3-settings-linked");
  });
  await step("sign out", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
    await shot("4-sign-in-with-forgot-link");
  });
  await step("forgot password: ask for a code", async () => {
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
    await shot("5-forgot-ask");
    await page.getByLabel("Email", { exact: true }).fill("dana@example.com");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByLabel("Code from the email", { exact: true })).toBeVisible();
    await shot("6-forgot-code");
  });
  await step("a wrong code is refused with a calm message", async () => {
    await page.getByLabel("Code from the email", { exact: true }).fill("AAAA-AAAA");
    await page.getByLabel("New password", { exact: true }).fill("dana-second-password");
    await page.getByLabel("New password again", { exact: true }).fill("dana-second-password");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByText("That code is wrong or has expired.")).toBeVisible();
    await shot("7-wrong-code");
  });
  await step("mismatched passwords are caught before sending", async () => {
    await page.getByLabel("New password again", { exact: true }).fill("something-else-entirely");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByText("The two passwords don’t match.")).toBeVisible();
  });
  await step("the real code resets the password", async () => {
    await page.getByLabel("Code from the email", { exact: true }).fill(await codeFrom("dana@example.com"));
    await page.getByLabel("New password again", { exact: true }).fill("dana-second-password");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByText("Password changed. Sign in with your new password.")).toBeVisible();
    await shot("8-back-at-sign-in");
  });
  await step("the old password no longer works, the new one does", async () => {
    await page.getByLabel("Username", { exact: true }).fill("dana");
    await page.getByLabel("Password", { exact: true }).fill("dana-first-password");
    await page.getByRole("button", { name: "Let’s go" }).click();
    await expect(page.getByText("Incorrect username or password.")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("dana-second-password");
    await page.getByRole("button", { name: "Let’s go" }).click();
    await expect(page.getByRole("button", { name: "Let’s go" })).toBeHidden();
  });
  if (errors.length) throw new Error("Page errors: " + errors.join("; "));
  console.log(`\nALL ${results.length} UI STEPS PASSED`);
} catch (e) {
  await shot("failure").catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await vite.close();
  await server.app.close();
}
