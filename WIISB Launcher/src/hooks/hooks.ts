import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/stores/appStore";
import { motionScale } from "@/utils/theme";
import { buildSortContext, filterGames, sortGames } from "@/utils/library";
import type { Game } from "@/types";

/** Debounced copy of a value (used for the search box). */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Current Unix time in seconds. Ticks every second only while `live` is true. */
export function useNow(live = false, ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    if (!live) return;
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => window.clearInterval(t);
  }, [live, ms]);
  return now;
}

/** True when Windows asks for reduced motion. */
export function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** 0 = no animation, 1 = normal. Combines the in-app settings with the OS preference. */
export function useMotionScale(): number {
  const settings = useApp((s) => s.settings);
  const os = useOsReducedMotion();
  return settings ? motionScale(settings, os) : 1;
}

/** Games after search / filters / sorting — shared by Library, Favourites and Recent. */
export function useLibraryView(overrides?: { favouritesOnly?: boolean }): { games: Game[]; total: number } {
  const games = useApp((s) => s.games);
  const sessions = useApp((s) => s.sessions);
  const settings = useApp((s) => s.settings);
  const query = useApp((s) => s.query);
  const favOnly = useApp((s) => s.favouritesOnly);
  const installedOnly = useApp((s) => s.installedOnly);
  const source = useApp((s) => s.sourceFilter);
  const debounced = useDebounced(query, 150);
  const hasActive = sessions.some((s) => s.completionStatus === "active");
  const now = useNow(hasActive, 15000);
  return useMemo(() => {
    const filtered = filterGames(games, {
      query: debounced,
      favouritesOnly: overrides?.favouritesOnly ?? favOnly,
      installedOnly,
      source,
    });
    const sorted = sortGames(filtered, settings?.sortBy ?? "name", buildSortContext(sessions, now));
    return { games: sorted, total: games.length };
  }, [games, sessions, settings?.sortBy, debounced, favOnly, installedOnly, source, overrides?.favouritesOnly, now]);
}
