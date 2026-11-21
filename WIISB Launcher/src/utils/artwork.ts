import { convertFileSrc } from "@tauri-apps/api/core";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hand-picked hues so each of the four games gets a distinct, tasteful placeholder. */
const HUES: Record<string, [number, number]> = {
  deltarune: [262, 214],
  "persona-3-reload": [208, 188],
  ultrakill: [8, 34],
  undertale: [338, 282],
};

/** Title-based generated artwork, used whenever no image has been supplied. */
export function placeholderGradient(slug: string, title: string): string {
  const [h1, h2] = HUES[slug] ?? [hash(title) % 360, (hash(title + "x") % 360)];
  return [
    `radial-gradient(120% 90% at 18% 8%, hsl(${h1} 82% 58% / 0.55), transparent 60%)`,
    `radial-gradient(110% 90% at 92% 95%, hsl(${h2} 78% 46% / 0.6), transparent 62%)`,
    `linear-gradient(155deg, hsl(${h1} 45% 16%), hsl(${h2} 50% 9%))`,
  ].join(", ");
}

/** Distinct, colour-blind-friendly series colours per game (used in charts + legends). */
// Validated with the dataviz palette checker: lightness band, chroma, CVD separation and 3:1 contrast
// against the dark surface (dark set) and the light surface (light set). Colour follows the game, never its rank.
export const GAME_COLORS: Record<string, { dark: string; light: string }> = {
  deltarune: { dark: "#8B5CF6", light: "#7C3AED" },
  undertale: { dark: "#BF800A", light: "#B45309" },
  "persona-3-reload": { dark: "#0EA5C6", light: "#0C8AA8" },
  ultrakill: { dark: "#EF4466", light: "#DC2650" },
};

export function gameColor(slug: string, light = false): string {
  const c = GAME_COLORS[slug];
  return c ? (light ? c.light : c.dark) : "#A78BFA";
}

/** Local image file → a URL the webview may load (served by Tauri's scoped asset protocol). */
export function artworkUrl(path: string | null): string | null {
  return path ? convertFileSrc(path) : null;
}
