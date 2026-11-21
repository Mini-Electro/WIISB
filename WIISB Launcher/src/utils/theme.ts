import type { AppSettings, ThemeId } from "@/types";

export interface ThemeOption {
  id: ThemeId;
  name: string;
  /** background, panel, accent — shown as the preview swatch (kept in step with styles/index.css). */
  swatch: [string, string, string];
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "midnight-purple", name: "Midnight Purple", swatch: ["#0C0D12", "#151722", "#8B5CF6"] },
  { id: "dark-blue", name: "Dark Blue", swatch: ["#0A0F1C", "#111A2E", "#3B82F6"] },
  { id: "oled-black", name: "OLED Black", swatch: ["#000000", "#0A0A0C", "#A78BFA"] },
  { id: "crimson", name: "Crimson", swatch: ["#110B0E", "#1B1115", "#E11D48"] },
  { id: "emerald", name: "Emerald", swatch: ["#07120F", "#0E1D18", "#10B981"] },
  { id: "light", name: "Light Mode", swatch: ["#F4F5F9", "#FFFFFF", "#7C3AED"] },
  { id: "light-sky", name: "Sky Light", swatch: ["#EEF4FB", "#FFFFFF", "#2563EB"] },
  { id: "light-rose", name: "Rose Light", swatch: ["#FBF1F4", "#FFFFFF", "#E11D48"] },
  { id: "light-mint", name: "Mint Light", swatch: ["#EDF7F2", "#FFFFFF", "#047857"] },
  { id: "light-sunset", name: "Sunset Light", swatch: ["#FBF3E8", "#FFFFFF", "#C2410C"] },
  { id: "light-graphite", name: "Graphite Light", swatch: ["#F1F2F4", "#FFFFFF", "#334155"] },
];

export const isLightTheme = (id: string): boolean => id === "light" || id.startsWith("light-");

/**
 * Remembers the background colour so the next start can paint it before the app has loaded
 * (otherwise a light theme would flash dark during start-up).
 */
export function rememberBootColour(root: HTMLElement = document.documentElement) {
  try {
    const bg = getComputedStyle(root).getPropertyValue("--c-bg").trim();
    if (bg) localStorage.setItem("wiisb.boot-bg", bg);
  } catch {
    /* storage unavailable — harmless */
  }
}

export const ACCENT_PRESETS = ["#8B5CF6", "#3B82F6", "#06B6D4", "#10B981", "#F59E0B", "#E11D48", "#EC4899"];

export type MotionScale = 0 | 0.5 | 1 | 1.5;

/** Combines the in-app toggles with the Windows "reduce motion" preference. */
export function motionScale(s: Pick<AppSettings, "animationIntensity" | "reduceMotion">, osPrefersReduced: boolean): MotionScale {
  if (s.reduceMotion || osPrefersReduced) return 0;
  return ({ none: 0, low: 0.5, normal: 1, high: 1.5 } as const)[s.animationIntensity];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** Linear mix of two #RRGGBB colours; t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Readable text colour (near-black / near-white) for a given background. */
export function onColor(bg: string): string {
  return luminance(bg) > 0.4 ? "#0C0D12" : "#FFFFFF";
}

const CUSTOM_VARS = ["--c-accent", "--c-accent-2", "--c-on-accent", "--c-bg", "--c-surface", "--c-elevated"] as const;

/** Applies theme tokens + user overrides to the document. Everything is a CSS variable. */
export function applyAppearance(s: AppSettings, osPrefersReduced: boolean, root: HTMLElement = document.documentElement) {
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  const scale = motionScale(s, osPrefersReduced);
  root.dataset.motion = scale === 0 ? "none" : String(scale);
  root.style.setProperty("--radius", `${s.cornerRadius}px`);
  root.style.setProperty("--motion", String(scale));

  for (const v of CUSTOM_VARS) root.style.removeProperty(v);
  if (s.accentColor) {
    root.style.setProperty("--c-accent", s.accentColor);
    root.style.setProperty("--c-accent-2", mixHex(s.accentColor, isLightTheme(s.theme) ? "#000000" : "#FFFFFF", 0.28));
    root.style.setProperty("--c-on-accent", onColor(s.accentColor));
  }
  const dark = !isLightTheme(s.theme);
  if (s.backgroundColor) {
    const bg = s.backgroundColor;
    const toward = luminance(bg) > 0.4 ? "#000000" : "#FFFFFF";
    root.style.setProperty("--c-bg", bg);
    if (!s.panelColor) {
      root.style.setProperty("--c-surface", mixHex(bg, toward, dark ? 0.05 : 0.03));
      root.style.setProperty("--c-elevated", mixHex(bg, toward, dark ? 0.1 : 0.06));
    }
  }
  if (s.panelColor) {
    const toward = luminance(s.panelColor) > 0.4 ? "#000000" : "#FFFFFF";
    root.style.setProperty("--c-surface", s.panelColor);
    root.style.setProperty("--c-elevated", mixHex(s.panelColor, toward, 0.07));
  }
}
