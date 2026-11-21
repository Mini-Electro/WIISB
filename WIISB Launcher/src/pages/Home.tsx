import { useMemo } from "react";
import { Clock, Gamepad2, Play, RefreshCw, Timer, Trophy, History } from "lucide-react";
import { useApp } from "@/stores/appStore";
import { useNow } from "@/hooks/hooks";
import { recentlyPlayed } from "@/utils/library";
import { effectiveDuration, summarize } from "@/utils/stats";
import { formatDuration, relativeTime } from "@/utils/format";
import { Artwork, FavouriteButton, GameCard, PlayButton, useGameStats } from "@/components/game";
import { EmptyState, StatTile } from "@/components/common";
import { Button } from "@/components/ui";

export function HomePage() {
  const games = useApp((s) => s.games);
  const sessions = useApp((s) => s.sessions);
  const openGame = useApp((s) => s.openGame);
  const navigate = useApp((s) => s.navigate);
  const scan = useApp((s) => s.scan);
  const scanning = useApp((s) => s.scanning);
  const requestLaunch = useApp((s) => s.requestLaunch);
  const runtime = useApp((s) => s.runtime);
  const stats = useGameStats();
  const live = sessions.some((s) => s.completionStatus === "active");
  const now = useNow(live, 15000);

  const recent = useMemo(() => recentlyPlayed(games, sessions), [games, sessions]);
  const summary = useMemo(() => summarize(sessions, games, now), [sessions, games, now]);
  // Featured: the most recently played game that can actually be launched now.
  const featured = recent.find((r) => r.game.installed) ?? null;
  const missing = games.filter((g) => !g.installed);
  const mostPlayed = summary.mostPlayed ? games.find((g) => g.slug === summary.mostPlayed!.slug) : null;
  const lastPlayed = summary.lastPlayed ? games.find((g) => g.slug === summary.lastPlayed!.slug) : null;
  const featuredBusy = featured ? !!runtime[featured.game.slug] : false;
  // Quick launch: favourites, then recently played, then the rest — capped so a big library stays tidy.
  const quick = useMemo(() => {
    const order = new Map(recent.map((r, i) => [r.game.slug, i]));
    return [...games]
      .sort((a, b) => Number(b.isFavourite) - Number(a.isFavourite) || (order.get(a.slug) ?? 999) - (order.get(b.slug) ?? 999) || a.sortOrder - b.sortOrder)
      .slice(0, 8);
  }, [games, recent]);

  return (
    <div className="page-pad space-y-[var(--gap)]">
      {/* Welcome */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1.5">WIISB Launcher</div>
          <h1 className="display text-[34px] font-bold leading-tight">Welcome back to WIISB Launcher</h1>
          <p className="mt-1 text-[15px] text-muted">Your games. Your library. Your way.</p>
        </div>
        {featured && (
          <Button size="lg" variant="primary" disabled={featuredBusy} icon={<Play size={18} fill="currentColor" />} className="display uppercase tracking-[0.14em]" onClick={() => requestLaunch(featured.game.slug)}>
            Continue playing
          </Button>
        )}
      </section>

      {/* Featured game */}
      {featured ? (
        <section className="panel relative isolate overflow-hidden">
          <Artwork game={featured.game} ratio="fill" titleSize="lg" className="!absolute inset-0 opacity-[0.55] blur-[2px] scale-105" />
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/80 to-bg/10" />
          <div className="relative flex min-h-[250px] flex-wrap items-end gap-6 p-7">
            <Artwork game={featured.game} ratio="poster" titleSize="sm" className="hidden w-[132px] shrink-0 cursor-pointer rounded-ctl border border-line-strong shadow-2xl sm:block" />
            <div className="min-w-0 flex-1">
              <div className="eyebrow mb-1">Continue where you left off</div>
              <button onClick={() => openGame(featured.game.slug)} className="display block max-w-full truncate text-left text-[40px] font-bold leading-none hover:text-accent2 t-transition">
                {featured.game.title}
              </button>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
                <span className="flex items-center gap-1.5"><Clock size={14} /> Last played {relativeTime(featured.lastPlayedAt, now)}</span>
                <span className="flex items-center gap-1.5"><Timer size={14} /> {formatDuration(stats[featured.game.slug]?.totalSecs ?? 0)} recorded playtime</span>
              </div>
              <div className="mt-5 flex items-center gap-3">
                <PlayButton game={featured.game} size="lg" className="min-w-[160px]" />
                <FavouriteButton game={featured.game} className="!bg-elevated border border-line" />
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel p-2">
          <EmptyState
            compact
            title={missing.length === games.length ? "Let's find your games" : "Ready when you are"}
            action={
              missing.length === games.length ? (
                <Button variant="primary" loading={scanning} icon={<RefreshCw size={16} />} onClick={() => void scan(false)}>Scan library folder</Button>
              ) : (
                <Button variant="primary" onClick={() => navigate("library")}>Open library</Button>
              )
            }
          >
            {missing.length === games.length
              ? "WIISB Launcher hasn't linked any games yet. Scan for games — your library folder, Steam, Epic and more — or point it at each game yourself."
              : "Launch a game and it will appear here as your featured title — with its real last-played time and playtime."}
          </EmptyState>
        </section>
      )}

      {/* Quick launch */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display text-lg font-semibold">Quick launch</h2>
          <Button size="sm" variant="ghost" onClick={() => navigate("library")}>View all {games.length} games</Button>
        </div>
        <div className="grid gap-[var(--gap)]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {quick.map((g, i) => (
            <GameCard key={g.slug} game={g} stats={stats[g.slug]} index={i} />
          ))}
        </div>
      </section>

      {/* Recently played + statistics */}
      <div className="grid gap-[var(--gap)] xl:grid-cols-[1.35fr_1fr]">
        <section className="panel p-5">
          <h2 className="display mb-3 flex items-center gap-2 text-lg font-semibold"><History size={18} className="text-accent2" /> Recently played</h2>
          {recent.length === 0 ? (
            <EmptyState compact title="Nothing played yet">Your launch history will appear here once you've played something through WIISB Launcher.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {recent.slice(0, 4).map(({ game, lastPlayedAt }) => {
                const last = [...sessions].filter((s) => s.slug === game.slug).sort((a, b) => b.startedAt - a.startedAt)[0];
                return (
                  <li key={game.slug} className="flex items-center gap-3 py-2.5">
                    <Artwork game={game} ratio="square" titleSize="sm" className="h-12 w-12 shrink-0 cursor-pointer rounded-ctl" />
                    <button className="min-w-0 flex-1 text-left" onClick={() => openGame(game.slug)}>
                      <div className="display truncate font-semibold">{game.title}</div>
                      <div className="text-xs text-muted">{relativeTime(lastPlayedAt, now)} · session {formatDuration(last ? effectiveDuration(last, now) : 0)}</div>
                    </button>
                    <PlayButton game={game} size="sm" className="min-w-[112px]" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="grid auto-rows-min gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <StatTile icon={<Gamepad2 size={20} />} label="Games in library" value={games.length} sub={`${games.filter((g) => g.installed).length} installed`} />
          <StatTile icon={<Timer size={20} />} label="Recorded playtime" value={formatDuration(summary.totalSecs)} sub="across all games" />
          <StatTile icon={<Clock size={20} />} label="Sessions" value={summary.completedCount} sub={summary.sessionCount > summary.completedCount ? `${summary.sessionCount - summary.completedCount} in progress` : "completed"} />
          <StatTile icon={<Trophy size={20} />} label="Most played" value={mostPlayed?.title ?? "—"} sub={summary.mostPlayed ? formatDuration(summary.mostPlayed.totalSecs) : "No data yet"} />
          <StatTile icon={<History size={20} />} label="Most recent" value={lastPlayed?.title ?? "—"} sub={summary.lastPlayed?.lastPlayedAt ? relativeTime(summary.lastPlayed.lastPlayedAt, now) : "No data yet"} />
        </section>
      </div>
    </div>
  );
}
