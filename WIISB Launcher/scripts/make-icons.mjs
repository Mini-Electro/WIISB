// Renders the WIISB mark to a 1024px PNG, then asks the Tauri CLI to generate
// every Windows icon size (.ico, Square*.png, installer icons) from it.
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public", "wiisb-mark.svg"));
const png = await sharp(svg, { density: 384 }).resize(1024, 1024).png().toBuffer();
const out = join(root, "assets", "app-icon.png");
writeFileSync(out, png);
execSync(`npx tauri icon "${out}" --output "${join(root, "src-tauri", "icons")}"`, { stdio: "inherit", cwd: root });
