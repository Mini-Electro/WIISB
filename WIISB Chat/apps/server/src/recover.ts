import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Database } from "./db.js";
import { config } from "./config.js";
import { passwordHash } from "./auth.js";
import { join } from "node:path";
// Run only on the server host; stop the embedded database server before using this command.
const username = process.argv[2];
if (!username)
  throw new Error("Usage: npm run recover -w @wiisb/server -- username");
const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question(
  "New password (visible in this local terminal): ",
);
rl.close();
if (password.length < 10 || password.length > 128)
  throw new Error("Password must be 10–128 characters.");
const db = await new Database().open(
  config.databaseUrl,
  join(config.dataDir, "postgres"),
);
const rows = await db.query(
  "UPDATE users SET password_hash=$1 WHERE username=$2 RETURNING id",
  [await passwordHash(password), username],
);
if (!rows.length) throw new Error("User not found.");
await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
  rows[0].id,
]);
await db.close();
console.log("Password changed and all sessions revoked.");
