import type { Game, Session, SortKey } from "@/types";
import { effectiveDuration } from "./stats";

export interface LibraryFilters {
  query: string;
  favouritesOnly: boolean;
  installedOnly: boolean;
  /** "all" | "steam" | "epic" | "folder" | "other" */
  source?: string;
}

export const DEFAULT_FILTERS: LibraryFilters = { query: "", favouritesOnly: false, installedOnly: false };

/** Extra words people search by (the folder/exe short names). Display data only. */
const ALIASES: Record<string, string> = { "persona-3-reload": "p3r persona3reload p3 reload" };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function matchesQuery(game: Pick<Game, "slug" | "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${game.title} ${ALIASES[game.slug] ?? ""}`.toLowerCase();
  if (hay.includes(q)) return true;
  const nq = norm(q);
  return nq.length > 0 && norm(hay).includes(nq);
}

export function filterGames(games: Game[], f: LibraryFilters): Game[] {
  return games.filter(
    (g) => matchesQuery(g, f.query) && (!f.favouritesOnly || g.isFavourite) && (!f.installedOnly || g.installed) && matchesSource(g.source, f.source ?? "all"),
  );
}

export interface SortContext {
  lastPlayed: Record<string, number>;
  playtime: Record<string, number>;
}

export function buildSortContext(sessions: Session[], nowSec: number): SortContext {
  const lastPlayed: Record<string, number> = {};
  const playtime: Record<string, number> = {};
  for (const s of sessions) {
    lastPlayed[s.slug] = Math.max(lastPlayed[s.slug] ?? 0, s.startedAt);
    playtime[s.slug] = (playtime[s.slug] ?? 0) + effectiveDuration(s, nowSec);
  }
  return { lastPlayed, playtime };
}

export function sortGames(games: Game[], key: SortKey, ctx: SortContext): Game[] {
  const byName = (a: Game, b: Game) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const list = [...games];
  switch (key) {
    case "lastPlayed":
      return list.sort((a, b) => (ctx.lastPlayed[b.slug] ?? 0) - (ctx.lastPlayed[a.slug] ?? 0) || byName(a, b));
    case "playtime":
      return list.sort((a, b) => (ctx.playtime[b.slug] ?? 0) - (ctx.playtime[a.slug] ?? 0) || byName(a, b));
    case "added":
      return list.sort((a, b) => b.addedAt - a.addedAt || a.sortOrder - b.sortOrder);
    default:
      return list.sort(byName);
  }
}

/** Games that have actually been played, most recent first. Never includes unplayed games. */
export function recentlyPlayed(games: Game[], sessions: Session[]): { game: Game; lastPlayedAt: number }[] {
  const last: Record<string, number> = {};
  for (const s of sessions) last[s.slug] = Math.max(last[s.slug] ?? 0, s.startedAt);
  return games
    .filter((g) => last[g.slug] !== undefined)
    .map((game) => ({ game, lastPlayedAt: last[game.slug] }))
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export const SOURCE_LABEL: Record<string, string> = {
  catalog: "Library folder",
  steam: "Steam",
  epic: "Epic Games",
  roblox: "Roblox",
  minecraft: "Minecraft",
  startmenu: "Start Menu",
  library: "Library folder",
  custom: "Added by you",
  pc: "Found on PC",
};

export const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "steam", label: "Steam" },
  { value: "epic", label: "Epic Games" },
  { value: "folder", label: "Library folder" },
  { value: "other", label: "Roblox, Minecraft & other" },
];

/** Does a game belong to the chosen source filter? ("folder" covers the built-in games and extra folders.) */
export function matchesSource(source: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "folder") return source === "catalog" || source === "library";
  if (filter === "other") return ["roblox", "minecraft", "startmenu", "custom", "pc"].includes(source);
  return source === filter;
}
