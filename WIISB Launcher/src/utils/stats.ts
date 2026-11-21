// Pure aggregation over persisted sessions. Nothing here invents data: every number is
// derived from the session list the backend returns.

import type { Game, Session, StatsRange } from "@/types";

export const DAY = 86400;

export interface GameStats {
  slug: string;
  totalSecs: number;
  sessionCount: number;
  averageSecs: number;
  longestSecs: number;
  lastSessionSecs: number | null;
  lastPlayedAt: number | null;
}

export interface Summary {
  totalSecs: number;
  sessionCount: number;
  completedCount: number;
  averageSecs: number;
  longestSecs: number;
  perGame: GameStats[];
  mostPlayed: GameStats | null;
  lastPlayed: GameStats | null;
}

/** Length of a session. A session that is still running counts up to `nowSec`. */
export function effectiveDuration(s: Session, nowSec: number): number {
  if (s.completionStatus === "active") return Math.max(0, nowSec - s.startedAt);
  return Math.max(0, s.durationSecs);
}

export function rangeStart(range: StatsRange, nowSec: number): number | null {
  switch (range) {
    case "7d":
      return nowSec - 7 * DAY;
    case "30d":
      return nowSec - 30 * DAY;
    case "90d":
      return nowSec - 90 * DAY;
    default:
      return null;
  }
}

export function filterByRange(sessions: Session[], range: StatsRange, nowSec: number): Session[] {
  const start = rangeStart(range, nowSec);
  return start === null ? sessions : sessions.filter((s) => s.startedAt >= start);
}

export function gameStats(slug: string, sessions: Session[], nowSec: number): GameStats {
  const mine = sessions.filter((s) => s.slug === slug).sort((a, b) => a.startedAt - b.startedAt);
  const durations = mine.map((s) => effectiveDuration(s, nowSec));
  const total = durations.reduce((a, b) => a + b, 0);
  const last = mine[mine.length - 1];
  return {
    slug,
    totalSecs: total,
    sessionCount: mine.length,
    averageSecs: mine.length ? total / mine.length : 0,
    longestSecs: durations.length ? Math.max(...durations) : 0,
    lastSessionSecs: last ? effectiveDuration(last, nowSec) : null,
    lastPlayedAt: last ? last.startedAt : null,
  };
}

export function summarize(sessions: Session[], games: Pick<Game, "slug">[], nowSec: number): Summary {
  const perGame = games.map((g) => gameStats(g.slug, sessions, nowSec));
  const durations = sessions.map((s) => effectiveDuration(s, nowSec));
  const total = durations.reduce((a, b) => a + b, 0);
  const played = perGame.filter((g) => g.sessionCount > 0);
  return {
    totalSecs: total,
    sessionCount: sessions.length,
    completedCount: sessions.filter((s) => s.completionStatus !== "active").length,
    averageSecs: sessions.length ? total / sessions.length : 0,
    longestSecs: durations.length ? Math.max(...durations) : 0,
    perGame,
    mostPlayed: played.length ? [...played].sort((a, b) => b.totalSecs - a.totalSecs)[0] : null,
    lastPlayed: played.length ? [...played].sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0] : null,
  };
}

/** `YYYY-MM-DD` in the viewer's local time zone (timestamps are stored in UTC). */
export function localDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DayBucket {
  date: string; // local YYYY-MM-DD
  secs: number;
  sessions: number;
}

/** Local midnight (as a Date) for the day containing `ts`. */
function startOfLocalDay(ts: number): Date {
  const d = new Date(ts * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * One bucket per local calendar day from the start of the range through today.
 * For "all", the series starts at the first recorded session (or is empty).
 */
export function dailySeries(sessions: Session[], range: StatsRange, nowSec: number): DayBucket[] {
  const startTs = rangeStart(range, nowSec) ?? (sessions.length ? Math.min(...sessions.map((s) => s.startedAt)) : null);
  if (startTs === null) return [];
  const first = startOfLocalDay(startTs);
  const last = startOfLocalDay(nowSec);
  const buckets = new Map<string, DayBucket>();
  for (let d = first; d <= last; d = addDays(d, 1)) {
    buckets.set(keyOf(d), { date: keyOf(d), secs: 0, sessions: 0 });
  }
  for (const s of sessions) {
    const b = buckets.get(localDayKey(s.startedAt));
    if (b) {
      b.secs += effectiveDuration(s, nowSec);
      b.sessions += 1;
    }
  }
  return [...buckets.values()];
}

export interface HeatCell {
  date: string;
  secs: number;
  /** 0 (none) … 4 (most) */
  level: 0 | 1 | 2 | 3 | 4;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  inFuture: boolean;
}

/** A week-column grid ending today (`weeks` columns, Sunday-first). */
export function heatmap(sessions: Session[], nowSec: number, weeks = 20): HeatCell[][] {
  const today = startOfLocalDay(nowSec);
  const gridStart = addDays(today, -(today.getDay() + (weeks - 1) * 7));
  const perDay = new Map<string, number>();
  for (const s of sessions) {
    const k = localDayKey(s.startedAt);
    perDay.set(k, (perDay.get(k) ?? 0) + effectiveDuration(s, nowSec));
  }
  const max = Math.max(0, ...perDay.values());
  const columns: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = addDays(gridStart, w * 7 + dow);
      const secs = perDay.get(keyOf(d)) ?? 0;
      const ratio = max > 0 ? secs / max : 0;
      const level = secs <= 0 ? 0 : ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
      col.push({ date: keyOf(d), secs, level: level as HeatCell["level"], weekday: dow, inFuture: d > today });
    }
    columns.push(col);
  }
  return columns;
}

/** Playtime this calendar week (Sunday-first) vs the week before. */
export function weeklySummary(sessions: Session[], nowSec: number) {
  const today = startOfLocalDay(nowSec);
  const thisWeek = addDays(today, -today.getDay()).getTime() / 1000;
  const lastWeek = thisWeek - 7 * DAY;
  let current = 0;
  let previous = 0;
  for (const s of sessions) {
    const d = effectiveDuration(s, nowSec);
    if (s.startedAt >= thisWeek) current += d;
    else if (s.startedAt >= lastWeek) previous += d;
  }
  return { current, previous, delta: current - previous };
}
