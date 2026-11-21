import { describe, expect, it } from "vitest";
import { buildSortContext, filterGames, matchesQuery, matchesSource, recentlyPlayed, sortGames } from "@/utils/library";
import { formatClock, formatDuration, relativeTime } from "@/utils/format";
import { applyAppearance, mixHex, motionScale, onColor } from "@/utils/theme";
import { placeholderGradient } from "@/utils/artwork";
import type { AppSettings, Game, Session } from "@/types";

const game = (slug: string, title: string, extra: Partial<Game> = {}): Game => ({
  id: 1,
  slug,
  title,
  sortOrder: 0,
  addedAt: 100,
  isFavourite: false,
  artworkPath: null,
  installationPath: null,
  launchTarget: null,
  launchMethod: "direct",
  launchArgs: "",
  workingDir: null,
  linkSource: null,
  linkedAt: null,
  lastValidatedAt: null,
  validationStatus: "not_linked",
  validationMessage: null,
  installed: false,
  source: "catalog",
  externalId: null,
  steamAppId: null,
  hidden: false,
  heroPath: null,
  iconPath: null,
  artAttempted: false,
  ...extra,
});

const GAMES = [
  game("deltarune", "DELTARUNE", { installed: true, addedAt: 1 }),
  game("persona-3-reload", "Persona 3 Reload", { isFavourite: true, installed: true, addedAt: 2 }),
  game("ultrakill", "ULTRAKILL", { addedAt: 3 }),
  game("undertale", "UNDERTALE", { isFavourite: true, installed: true, addedAt: 4 }),
];

const sess = (slug: string, startedAt: number, secs: number): Session => ({
  id: startedAt,
  gameId: 1,
  slug,
  startedAt,
  endedAt: startedAt + secs,
  durationSecs: secs,
  launchMethod: "direct",
  confirmationStatus: "confirmed",
  completionStatus: "completed",
  lastHeartbeat: startedAt,
});

describe("search", () => {
  it("is case-insensitive and punctuation-tolerant", () => {
    expect(matchesQuery(GAMES[1], "persona")).toBe(true);
    expect(matchesQuery(GAMES[1], "PERSONA 3")).toBe(true);
    expect(matchesQuery(GAMES[1], "persona3reload")).toBe(true);
    expect(matchesQuery(GAMES[1], "p3r")).toBe(true);
    expect(matchesQuery(GAMES[2], "kill")).toBe(true);
    expect(matchesQuery(GAMES[0], "zelda")).toBe(false);
    expect(matchesQuery(GAMES[0], "   ")).toBe(true);
  });
});

describe("filters", () => {
  it("filters by favourites, installed status and text", () => {
    const f = (o: object) => filterGames(GAMES, { query: "", favouritesOnly: false, installedOnly: false, ...o }).map((g) => g.slug);
    expect(f({})).toHaveLength(4);
    expect(f({ favouritesOnly: true })).toEqual(["persona-3-reload", "undertale"]);
    expect(f({ installedOnly: true })).toEqual(["deltarune", "persona-3-reload", "undertale"]);
    expect(f({ query: "under", favouritesOnly: true })).toEqual(["undertale"]);
    expect(f({ query: "nothing" })).toEqual([]);
  });
});

describe("source filter", () => {
  const mixed = [
    game("deltarune", "DELTARUNE"),
    game("steam-4000", "Garry's Mod", { source: "steam" }),
    game("epic-fortnite", "Fortnite", { source: "epic" }),
    game("roblox-player", "Roblox", { source: "roblox" }),
    game("library-fnaf-2", "FNAF 2", { source: "library" }),
    game("custom-x", "My Game", { source: "custom" }),
  ];
  const slugs = (source: string) => filterGames(mixed, { query: "", favouritesOnly: false, installedOnly: false, source }).map((g) => g.slug);
  it("groups games by where they came from", () => {
    expect(slugs("all")).toHaveLength(6);
    expect(slugs("steam")).toEqual(["steam-4000"]);
    expect(slugs("epic")).toEqual(["epic-fortnite"]);
    expect(slugs("folder")).toEqual(["deltarune", "library-fnaf-2"]);
    expect(slugs("other")).toEqual(["roblox-player", "custom-x"]);
    expect(matchesSource("steam", "all")).toBe(true);
  });
  it("combines with text search", () => {
    expect(filterGames(mixed, { query: "mod", favouritesOnly: false, installedOnly: false, source: "steam" })).toHaveLength(1);
    expect(filterGames(mixed, { query: "mod", favouritesOnly: false, installedOnly: false, source: "epic" })).toHaveLength(0);
  });
});

describe("sorting", () => {
  const sessions = [sess("ultrakill", 1000, 5000), sess("undertale", 3000, 100), sess("deltarune", 2000, 900)];
  const ctx = buildSortContext(sessions, 5000);
  const order = (key: Parameters<typeof sortGames>[1]) => sortGames(GAMES, key, ctx).map((g) => g.slug);

  it("by name", () => expect(order("name")).toEqual(["deltarune", "persona-3-reload", "ultrakill", "undertale"]));
  it("by last played, unplayed last", () => expect(order("lastPlayed")).toEqual(["undertale", "deltarune", "ultrakill", "persona-3-reload"]));
  it("by playtime", () => expect(order("playtime")).toEqual(["ultrakill", "deltarune", "undertale", "persona-3-reload"]));
  it("by recently added", () => expect(order("added")).toEqual(["undertale", "ultrakill", "persona-3-reload", "deltarune"]));
  it("does not mutate its input", () => {
    const copy = [...GAMES];
    sortGames(GAMES, "playtime", ctx);
    expect(GAMES).toEqual(copy);
  });
});

describe("recently played", () => {
  it("never includes unplayed games and orders by latest session", () => {
    const r = recentlyPlayed(GAMES, [sess("deltarune", 10, 1), sess("undertale", 30, 1), sess("deltarune", 20, 1)]);
    expect(r.map((x) => x.game.slug)).toEqual(["undertale", "deltarune"]);
    expect(r[1].lastPlayedAt).toBe(20);
    expect(recentlyPlayed(GAMES, [])).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 05m");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(65)).toBe("1:05");
  });
  it("formats relative time", () => {
    const now = 1_000_000;
    expect(relativeTime(now - 10, now)).toBe("just now");
    expect(relativeTime(now - 120, now)).toBe("2 minutes ago");
    expect(relativeTime(now - 7200, now)).toBe("2 hours ago");
    expect(relativeTime(now - 86400 * 1.2, now)).toBe("yesterday");
    expect(relativeTime(now - 86400 * 5, now)).toBe("5 days ago");
  });
});

describe("theme system", () => {
  const base = { animationIntensity: "normal", reduceMotion: false } as Pick<AppSettings, "animationIntensity" | "reduceMotion">;
  it("scales motion and respects reduced-motion preferences", () => {
    expect(motionScale(base, false)).toBe(1);
    expect(motionScale({ ...base, animationIntensity: "high" }, false)).toBe(1.5);
    expect(motionScale({ ...base, animationIntensity: "none" }, false)).toBe(0);
    expect(motionScale(base, true)).toBe(0);
    expect(motionScale({ ...base, reduceMotion: true }, false)).toBe(0);
  });
  it("mixes colours and picks readable text", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(onColor("#8B5CF6")).toBe("#FFFFFF");
    expect(onColor("#FDE68A")).toBe("#0C0D12");
  });
  it("applies tokens to an element and clears overrides on reset", () => {
    const style = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) },
    } as unknown as HTMLElement;
    const s = { theme: "emerald", density: "compact", cornerRadius: 20, animationIntensity: "normal", reduceMotion: false, accentColor: "#FF0000", backgroundColor: null, panelColor: null } as AppSettings;
    applyAppearance(s, false, root);
    expect(root.dataset.theme).toBe("emerald");
    expect(root.dataset.density).toBe("compact");
    expect(style.get("--radius")).toBe("20px");
    expect(style.get("--c-accent")).toBe("#FF0000");
    applyAppearance({ ...s, accentColor: null }, false, root);
    expect(style.has("--c-accent")).toBe(false);
  });
});

describe("artwork placeholders", () => {
  it("is deterministic per game and different between games", () => {
    expect(placeholderGradient("ultrakill", "ULTRAKILL")).toBe(placeholderGradient("ultrakill", "ULTRAKILL"));
    expect(placeholderGradient("ultrakill", "ULTRAKILL")).not.toBe(placeholderGradient("undertale", "UNDERTALE"));
  });
});
