import { z } from "zod";
export const themeSchema = z.object({
  name: z.string().min(1).max(50),
  accent: z.string().regex(/^#[a-f\d]{6}$/i),
  background: z.string().regex(/^#[a-f\d]{6}$/i),
  panel: z.string().regex(/^#[a-f\d]{6}$/i),
  surface: z.string().regex(/^#[a-f\d]{6}$/i),
  text: z.string().regex(/^#[a-f\d]{6}$/i),
  muted: z.string().regex(/^#[a-f\d]{6}$/i),
  fontSize: z.number().min(12).max(20).default(14),
  radius: z.number().min(0).max(24).default(12),
  reducedMotion: z.boolean().default(false),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
});
export type Theme = z.infer<typeof themeSchema>;
const base = {
  background: "#090a10",
  panel: "#11131d",
  surface: "#191c29",
  text: "#f8fafc",
  muted: "#a3acc0",
  fontSize: 14,
  radius: 12,
  reducedMotion: false,
  density: "comfortable" as const,
};
export const themes: Theme[] = [
  // The default: Discord's familiar three-layer dark palette (rail < sidebar < chat) with its blurple accent.
  {
    name: "Discord Dark",
    accent: "#5865f2",
    background: "#313338",
    panel: "#2b2d31",
    surface: "#383a40",
    text: "#f2f3f5",
    muted: "#b5bac1",
    fontSize: 15,
    radius: 8,
    reducedMotion: false,
    density: "comfortable",
  },
  { name: "Midnight Purple", accent: "#8b5cf6", ...base },
  {
    name: "AMOLED Black",
    ...base,
    background: "#000000",
    panel: "#080808",
    surface: "#141414",
    accent: "#b197fc",
  },
  {
    name: "Neon Blue",
    ...base,
    background: "#07101b",
    panel: "#0a1726",
    surface: "#112438",
    accent: "#38bdf8",
  },
  {
    name: "Crimson Red",
    ...base,
    accent: "#fb7185",
    panel: "#1b1018",
    surface: "#2b1724",
  },
  {
    name: "Emerald Green",
    ...base,
    accent: "#34d399",
    background: "#08110e",
    panel: "#101d18",
    surface: "#172a22",
  },
  {
    name: "Sakura Pink",
    ...base,
    accent: "#f9a8d4",
    panel: "#1f1422",
    surface: "#302035",
  },
  {
    name: "Arctic White",
    ...base,
    accent: "#7c3aed",
    background: "#f3f4f8",
    panel: "#ffffff",
    surface: "#e9eaf2",
    text: "#171825",
    muted: "#5c6478",
  },
  {
    name: "Cyberpunk",
    ...base,
    accent: "#e879f9",
    background: "#100b20",
    panel: "#19102f",
    surface: "#271644",
  },
  {
    name: "Sunset",
    ...base,
    accent: "#fb923c",
    background: "#171017",
    panel: "#231721",
    surface: "#352432",
  },
];
export function savedThemes(): Theme[] {
  try {
    return z
      .array(themeSchema)
      .max(30)
      .parse(JSON.parse(localStorage.getItem("wiisb.themes") || "[]"));
  } catch {
    return [];
  }
}
// Bump when the default look changes: people still on the *untouched* old default get the new one once.
const LOOK = "discord-v1";
export function loadTheme() {
  try {
    const stored = themeSchema.parse(
      JSON.parse(localStorage.getItem("wiisb.theme") || "null"),
    );
    if (localStorage.getItem("wiisb.look") !== LOOK) {
      localStorage.setItem("wiisb.look", LOOK);
      const untouchedOldDefault =
        stored.name === "Midnight Purple" &&
        stored.background === "#090a10" &&
        stored.panel === "#11131d" &&
        stored.accent === "#8b5cf6";
      if (untouchedOldDefault) return themes[0];
    }
    return stored;
  } catch {
    return themes[0];
  }
}
const channel = (hex: string, i: number) =>
  parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
function mix(a: string, b: string, t: number) {
  const c = (i: number) =>
    Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)
      .toString(16)
      .padStart(2, "0");
  return "#" + c(0) + c(1) + c(2);
}
const brightness = (hex: string) =>
  (channel(hex, 0) * 299 + channel(hex, 1) * 587 + channel(hex, 2) * 114) /
  255000;
export function applyTheme(theme: Theme) {
  const t = themeSchema.parse(theme),
    root = document.documentElement;
  for (const key of [
    "accent",
    "background",
    "panel",
    "surface",
    "text",
    "muted",
  ] as const)
    root.style.setProperty("--" + key, t[key]);
  // The server rail and the account bar sit one and two steps "below" the sidebar, as in Discord.
  const light = brightness(t.background) > 0.55;
  root.style.setProperty(
    "--rail",
    light ? mix(t.panel, t.text, 0.1) : mix(t.panel, "#000000", 0.4),
  );
  root.style.setProperty(
    "--dock",
    light ? mix(t.panel, t.text, 0.06) : mix(t.panel, "#000000", 0.2),
  );
  root.style.setProperty("--font-size", t.fontSize + "px");
  root.style.setProperty("--radius", t.radius + "px");
  root.dataset.motion = t.reducedMotion ? "reduced" : "normal";
  root.dataset.density = t.density;
  localStorage.setItem("wiisb.theme", JSON.stringify(t));
}
