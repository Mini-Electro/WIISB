import { describe, expect, it } from "vitest";
import { dailySeries, effectiveDuration, filterByRange, gameStats, heatmap, summarize, weeklySummary } from "@/utils/stats";
import type { Session } from "@/types";

const games = [{ slug: "deltarune" }, { slug: "undertale" }, { slug: "ultrakill" }, { slug: "persona-3-reload" }];

let id = 1;
const session = (slug: string, startedAt: number, secs: number, status: Session["completionStatus"] = "completed"): Session => ({
  id: id++,
  gameId: 1,
  slug,
  startedAt,
  endedAt: status === "active" ? null : startedAt + secs,
  durationSecs: status === "active" ? 0 : secs,
  launchMethod: "direct",
  confirmationStatus: "confirmed",
  completionStatus: status,
  lastHeartbeat: startedAt,
});

// A fixed "now": local noon, so day boundaries are time-zone independent for these tests.
const NOW = Math.floor(new Date(2026, 5, 15, 12, 0, 0).getTime() / 1000);
const DAYS = (n: number) => n * 86400;

describe("session durations", () => {
  it("uses the stored duration for finished sessions and live time for active ones", () => {
    expect(effectiveDuration(session("deltarune", NOW - 100, 60), NOW)).toBe(60);
    expect(effectiveDuration(session("deltarune", NOW - 100, 0, "active"), NOW)).toBe(100);
    expect(effectiveDuration(session("deltarune", NOW + 50, 0, "active"), NOW)).toBe(0);
  });
});

describe("summaries", () => {
  const sessions = [
    session("ultrakill", NOW - DAYS(1), 3600),
    session("ultrakill", NOW - DAYS(2), 1800),
    session("undertale", NOW - DAYS(10), 600),
    session("deltarune", NOW - 600, 0, "active"),
  ];

  it("aggregates totals, counts, average, longest", () => {
    const s = summarize(sessions, games, NOW);
    expect(s.totalSecs).toBe(3600 + 1800 + 600 + 600);
    expect(s.sessionCount).toBe(4);
    expect(s.completedCount).toBe(3);
    expect(s.longestSecs).toBe(3600);
    expect(s.averageSecs).toBeCloseTo(6600 / 4);
  });

  it("finds most played and last played from real data", () => {
    const s = summarize(sessions, games, NOW);
    expect(s.mostPlayed?.slug).toBe("ultrakill");
    expect(s.lastPlayed?.slug).toBe("deltarune");
    const p3r = s.perGame.find((g) => g.slug === "persona-3-reload")!;
    expect(p3r.sessionCount).toBe(0);
    expect(p3r.lastPlayedAt).toBeNull();
  });

  it("reports no most/last played when there are no sessions (nothing invented)", () => {
    const s = summarize([], games, NOW);
    expect(s.mostPlayed).toBeNull();
    expect(s.lastPlayed).toBeNull();
    expect(s.totalSecs).toBe(0);
    expect(s.averageSecs).toBe(0);
  });

  it("computes per-game stats incl. most recent session", () => {
    const g = gameStats("ultrakill", sessions, NOW);
    expect(g.sessionCount).toBe(2);
    expect(g.totalSecs).toBe(5400);
    expect(g.averageSecs).toBe(2700);
    expect(g.lastSessionSecs).toBe(3600);
  });
});

describe("ranges", () => {
  const sessions = [session("a", NOW - DAYS(3), 60), session("a", NOW - DAYS(20), 60), session("a", NOW - DAYS(60), 60), session("a", NOW - DAYS(200), 60)];
  it("filters by 7/30/90 days and all time", () => {
    expect(filterByRange(sessions, "7d", NOW)).toHaveLength(1);
    expect(filterByRange(sessions, "30d", NOW)).toHaveLength(2);
    expect(filterByRange(sessions, "90d", NOW)).toHaveLength(3);
    expect(filterByRange(sessions, "all", NOW)).toHaveLength(4);
  });
});

describe("daily series & heatmap", () => {
  it("creates a bucket per local day and sums into the right day", () => {
    const sessions = [session("a", NOW - DAYS(1), 1000), session("a", NOW - DAYS(1) + 60, 500), session("a", NOW, 100)];
    const days = dailySeries(sessions, "7d", NOW);
    expect(days.length).toBeGreaterThanOrEqual(8);
    expect(days[days.length - 1].secs).toBe(100);
    expect(days[days.length - 2]).toMatchObject({ secs: 1500, sessions: 2 });
    expect(days.reduce((a, d) => a + d.secs, 0)).toBe(1600);
  });

  it("returns an empty series for 'all' with no sessions", () => {
    expect(dailySeries([], "all", NOW)).toEqual([]);
  });

  it("builds a 7-row week grid with the busiest day at level 4", () => {
    const weeks = heatmap([session("a", NOW - DAYS(2), 7200), session("a", NOW - DAYS(3), 600)], NOW, 8);
    expect(weeks).toHaveLength(8);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const cells = weeks.flat();
    expect(Math.max(...cells.map((c) => c.level))).toBe(4);
    expect(cells.filter((c) => c.secs > 0)).toHaveLength(2);
    expect(cells.some((c) => c.inFuture)).toBe(true);
  });

  it("compares this week with last week", () => {
    const w = weeklySummary([session("a", NOW - 3600, 1000), session("a", NOW - DAYS(8), 400)], NOW);
    expect(w.current).toBe(1000);
    expect(w.previous).toBeGreaterThanOrEqual(0);
    expect(w.delta).toBe(w.current - w.previous);
  });
});
