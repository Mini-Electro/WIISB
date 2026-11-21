import { useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, CircleHelp, Heart, HardDrive, Plus, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { useApp } from "@/stores/appStore";
import { useLibraryView, useNow } from "@/hooks/hooks";
import { recentlyPlayed, matchesQuery, SOURCE_FILTERS } from "@/utils/library";
import { effectiveDuration } from "@/utils/stats";
import { formatDateTime, formatDuration, relativeTime } from "@/utils/format";
import { Artwork, GameCard, GameRow, PlayButton, useGameStats } from "@/components/game";
import { EmptyState, PageHeader } from "@/components/common";
import { Badge, Button, Select } from "@/components/ui";
import type { LaunchEntry } from "@/types";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold t-transition grow ${active ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

export function LibraryPage({ variant }: { variant: "library" | "favourites" }) {
  const fav = variant === "favourites";
  const { games, total } = useLibraryView({ favouritesOnly: fav ? true : undefined });
  const settings = useApp((s) => s.settings)!;
  const stats = useGameStats();
  const favouritesOnly = useApp((s) => s.favouritesOnly);
  const installedOnly = useApp((s) => s.installedOnly);
  const source = useApp((s) => s.sourceFilter);
  const setModal = useApp((s) => s.setModal);
  const openDeepScan = useApp((s) => s.openDeepScan);
  const setFilters = useApp((s) => s.setFilters);
  const query = useApp((s) => s.query);
  const scan = useApp((s) => s.scan);
  const scanning = useApp((s) => s.scanning);
  const navigate = useApp((s) => s.navigate);
  const setQuery = useApp((s) => s.setQuery);

  return (
    <div className="page-pad">
      <PageHeader eyebrow={fav ? "Your picks" : "Your collection"} title={fav ? "Favourites" : "Game library"}>
        {!fav && (
          <>
            <Chip active={favouritesOnly} onClick={() => setFilters({ favouritesOnly: !favouritesOnly })}>
              <Heart size={13} fill={favouritesOnly ? "currentColor" : "none"} /> Favourites
            </Chip>
            <Chip active={installedOnly} onClick={() => setFilters({ installedOnly: !installedOnly })}>
              <CircleCheck size={13} /> Installed
            </Chip>
          </>
        )}
        {fav && installedOnly !== undefined && (
          <Chip active={installedOnly} onClick={() => setFilters({ installedOnly: !installedOnly })}>
            <CircleCheck size={13} /> Installed
          </Chip>
        )}
        <Select label="Source" value={source} options={SOURCE_FILTERS} onChange={(v) => setFilters({ sourceFilter: v })} className="!h-8 text-[13px]" />
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setModal({ type: "addGame" })}>
          Add game
        </Button>
        <Button size="sm" variant="secondary" loading={scanning} icon={<RefreshCw size={14} />} onClick={() => void scan(false)} title="Look for new games in your library folder, Steam, Epic and more">
          Scan for games
        </Button>
        <Button size="sm" variant="primary" icon={<HardDrive size={14} />} onClick={() => void openDeepScan()} title="Search every drive for installed games">
          Scan whole PC
        </Button>
      </PageHeader>

      {games.length === 0 ? (
        <div className="panel">
          {query ? (
            <EmptyState title="No games match your search" action={<Button variant="secondary" onClick={() => setQuery("")}>Clear search</Button>}>
              Nothing in your library matches “{query}”.
            </EmptyState>
          ) : fav ? (
            <EmptyState title="No favourites yet" action={<Button variant="primary" onClick={() => navigate("library")}>Browse library</Button>}>
              Tap the heart on any game to pin it here.
            </EmptyState>
          ) : (
            <EmptyState title="No games to show" action={<Button variant="secondary" onClick={() => setFilters({ favouritesOnly: false, installedOnly: false, sourceFilter: "all" })}>Clear filters</Button>}>
              {total > 0 ? "Your current filters hide every game." : "Scan your library folder to link your games."}
            </EmptyState>
          )}
        </div>
      ) : settings.viewMode === "grid" ? (
        <div className="grid gap-[var(--gap)]" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${settings.cardSize}px, 1fr))` }}>
          {games.map((g, i) => (
            <GameCard key={g.slug} game={g} stats={stats[g.slug]} index={i} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {games.map((g) => (
            <GameRow key={g.slug} game={g} stats={stats[g.slug]} />
          ))}
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<LaunchEntry["outcome"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  confirmed: { label: "Started", tone: "success" },
  started: { label: "Requested", tone: "neutral" },
  unconfirmed: { label: "Unconfirmed", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export function RecentPage() {
  const games = useApp((s) => s.games);
  const sessions = useApp((s) => s.sessions);
  const query = useApp((s) => s.query);
  const openGame = useApp((s) => s.openGame);
  const navigate = useApp((s) => s.navigate);
  const live = sessions.some((s) => s.completionStatus === "active");
  const now = useNow(live, 15000);
  const [launches, setLaunches] = useState<LaunchEntry[]>([]);
  useEffect(() => {
    api.launches(30).then(setLaunches).catch(() => {});
  }, [sessions]);

  const recent = useMemo(() => recentlyPlayed(games, sessions).filter((r) => matchesQuery(r.game, query)), [games, sessions, query]);
  const feed = useMemo(
    () => [...sessions].filter((s) => matchesQuery({ slug: s.slug, title: games.find((g) => g.slug === s.slug)?.title ?? s.slug }, query)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 25),
    [sessions, games, query],
  );

  return (
    <div className="page-pad space-y-[var(--gap)]">
      <PageHeader eyebrow="Pick up where you left off" title="Recently played" />
      {recent.length === 0 ? (
        <div className="panel">
          <EmptyState title="Nothing played yet" action={<Button variant="primary" onClick={() => navigate("library")}>Open library</Button>}>
            Games you launch through WIISB Launcher show up here, with their real session history.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
          {recent.map(({ game, lastPlayedAt }) => (
            <div key={game.slug} className="panel flex items-center gap-4 p-3">
              <Artwork game={game} ratio="poster" titleSize="sm" className="w-16 shrink-0 cursor-pointer rounded-ctl" />
              <button className="min-w-0 flex-1 text-left" onClick={() => openGame(game.slug)}>
                <div className="display truncate text-lg font-semibold">{game.title}</div>
                <div className="text-[13px] text-muted">Last played {relativeTime(lastPlayedAt, now)}</div>
              </button>
              <PlayButton game={game} size="sm" className="min-w-[112px]" />
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-[var(--gap)] xl:grid-cols-2">
        <section className="panel p-5">
          <h2 className="display mb-3 text-lg font-semibold">Session history</h2>
          {feed.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">No sessions recorded yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {feed.map((s) => {
                const g = games.find((x) => x.slug === s.slug);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{g?.title ?? s.slug}</div>
                      <div className="text-xs text-muted">{formatDateTime(s.startedAt)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.completionStatus === "active" && <Badge tone="success">Playing</Badge>}
                      {s.completionStatus === "recovered" && <Badge tone="warning" className="cursor-help" >Recovered</Badge>}
                      <span className="w-16 text-right font-semibold tabular-nums">{formatDuration(effectiveDuration(s, now))}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel p-5">
          <h2 className="display mb-1 text-lg font-semibold">Launch log</h2>
          <p className="mb-3 text-xs text-muted">Every launch attempt, including ones that failed or couldn't be confirmed.</p>
          {launches.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">No launches yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {launches.map((l) => {
                const o = OUTCOME[l.outcome];
                return (
                  <li key={l.id} className="py-2.5 text-[13px]">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-semibold">{games.find((g) => g.slug === l.slug)?.title ?? l.slug}</span>
                      <Badge tone={o.tone}>
                        {l.outcome === "failed" ? <CircleAlert size={11} /> : l.outcome === "unconfirmed" ? <CircleHelp size={11} /> : null}
                        {o.label}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted">
                      {formatDateTime(l.attemptedAt)} · {l.launchMethod}
                      {l.error ? ` · ${l.error}` : ""}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
