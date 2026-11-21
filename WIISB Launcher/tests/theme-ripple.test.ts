import { describe, expect, it } from "vitest";
import { isLightTheme, luminance, THEME_OPTIONS } from "@/utils/theme";
import { MAX_RIPPLE_WIDTH, rippleSize, shouldRipple } from "@/utils/ripple";

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("themes", () => {
  it("has unique ids and valid swatch colours", () => {
    const ids = THEME_OPTIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of THEME_OPTIONS) for (const c of t.swatch) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("offers several light themes and detects them", () => {
    const light = THEME_OPTIONS.filter((t) => isLightTheme(t.id));
    expect(light.length).toBeGreaterThanOrEqual(5);
    for (const t of THEME_OPTIONS) {
      // A theme is "light" exactly when its background is bright — the id and the colours must agree.
      expect(isLightTheme(t.id), t.id).toBe(luminance(t.swatch[0]) > 0.5);
    }
    expect(isLightTheme("midnight-purple")).toBe(false);
  });

  it("keeps white text readable on every light theme's accent colour", () => {
    for (const t of THEME_OPTIONS.filter((t) => isLightTheme(t.id))) {
      expect(contrast(t.swatch[2], "#FFFFFF"), `${t.id} accent vs white`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives light themes panels that are brighter than or equal to the page", () => {
    for (const t of THEME_OPTIONS.filter((t) => isLightTheme(t.id))) {
      expect(luminance(t.swatch[1])).toBeGreaterThanOrEqual(luminance(t.swatch[0]));
    }
  });
});

describe("click ripple", () => {
  it("is big enough to cover the whole element from wherever you click", () => {
    const w = 200;
    const h = 40;
    for (const [x, y] of [[0, 0], [w, h], [100, 20], [w, 0], [0, h]]) {
      const r = rippleSize(w, h, x, y) / 2;
      for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) expect(Math.hypot(cx - x, cy - y)).toBeLessThanOrEqual(r);
    }
  });

  it("skips disabled controls, opted-out areas, tiny and page-sized elements", () => {
    const mk = (html: string) => {
      const doc = { matches: (sel: string) => html.includes("disabled") && sel.includes(":disabled"), closest: (sel: string) => (html.includes("no-ripple") && sel.includes("data-no-ripple") ? {} : null) };
      return doc as unknown as HTMLElement;
    };
    const box = { width: 120, height: 36 };
    expect(shouldRipple(mk("ok"), box)).toBe(true);
    expect(shouldRipple(mk("disabled"), box)).toBe(false);
    expect(shouldRipple(mk("no-ripple"), box)).toBe(false);
    expect(shouldRipple(mk("ok"), { width: 4, height: 4 })).toBe(false);
    expect(shouldRipple(mk("ok"), { width: MAX_RIPPLE_WIDTH + 1, height: 300 })).toBe(false);
  });
});
