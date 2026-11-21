// Generates the app icons (icon.png + a multi-size icon.ico) from the single logo source
// apps/desktop/public/logo.svg, so the in-app logo, window icon, taskbar and installer always match.
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const folder = new URL("../apps/desktop/src-tauri/icons/", import.meta.url);
const source = await readFile(
  new URL("../apps/desktop/public/logo.svg", import.meta.url),
);
await mkdir(folder, { recursive: true });

// High-density render so small sizes are downscaled from crisp vectors, not blown-up bitmaps.
const render = (size) =>
  sharp(source, { density: Math.max(72, size * 3) })
    .resize(size, size)
    .png()
    .toBuffer();

await writeFile(new URL("icon.png", folder), await render(512));

// Windows picks the nearest size for the taskbar, title bar, Alt+Tab and file explorer.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const chunks = [];
for (const size of sizes) chunks.push(await render(size));

const header = Buffer.alloc(6 + 16 * chunks.length);
header.writeUInt16LE(1, 2); // ICO type
header.writeUInt16LE(chunks.length, 4);
let offset = header.length;
chunks.forEach((b, i) => {
  const p = 6 + i * 16;
  header[p] = sizes[i] === 256 ? 0 : sizes[i]; // width (0 = 256)
  header[p + 1] = header[p]; // height
  header.writeUInt16LE(1, p + 4); // colour planes
  header.writeUInt16LE(32, p + 6); // bits per pixel
  header.writeUInt32LE(b.length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += b.length;
});
await writeFile(
  new URL("icon.ico", folder),
  Buffer.concat([header, ...chunks]),
);
console.log(`icons written: icon.png (512) and icon.ico (${sizes.join(", ")})`);
