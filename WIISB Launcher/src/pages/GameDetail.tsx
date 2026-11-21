import { useEffect, useMemo, useState } from "react";
import { ChartColumn, Check, CloudDownload, EyeOff, FolderOpen, ImagePlus, Link2, Pencil, RefreshCw, Rocket, Trash2, Unlink } from "lucide-react";
import { api } from "@/services/api";
import { useApp } from "@/stores/appStore";
import { useNow } from "@/hooks/hooks";
import { effectiveDuration, gameStats } from "@/utils/stats";
import { formatDate, formatDateTime, formatDuration, relativeTime } from "@/utils/format";
import { SOURCE_LABEL } from "@/utils/library";
import { Artwork, FavouriteButton, PlayButton, StatusBadge } from "@/components/game";
import { EmptyState } from "@/components/common";
import { Badge, Button } from "@/components/ui";
import { chooseArtwork, reveal, resetArtwork, unlink } from "@/features/library";
import type { Game } from "@/types";

const METHOD_LABEL = { direct: "Direct executable", platform: "Platform launch link", shortcut: "Windows shortcut" } as const;
const STATUS_TEXT: Record<Game["validationStatus"], string> = {
  ok: "Valid — launch target found",
  missing: "Missing",
  invalid: "Invalid",
  not_linked: "Not linked",
  drive_unavailable: "Drive unavailable",
};

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 break-all text-[13px] ${mono ? "font-mono text-[12px]" : "font-medium"}`}>{value}</div>
    </div>
  );
}

function Notes({ slug }: { slug: string }) {
  const toast = useApp((s) => s.toast);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    api.getNotes(slug).then((n) => (setText(n), setSaved(n), setLoaded(true))).catch(() => setLoaded(true));
  }, [slug]);
  const dirty = text !== saved;
  const save = async (body: string) => {
    try {
      await api.setNotes(slug, body);
      setSaved(body);
      setText(body);
      toast("success", body ? "Notes saved" : "Notes deleted");
    } catch (e) {
      toast("error", "Couldn't save notes", (e as Error).message);
    }
  };
  return (
    <section className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="display text-lg font-semibold">Personal notes</h2>
        <div className="flex items-center gap-2">
          {!dirty && saved && <Badge tone="success"><Check size={11} /> Saved</Badge>}
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={!text && !saved} onClick={() => void save("")}>Delete</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save(text)}>Save notes</Button>
        </div>
      </div>
      <textarea
        value={text}
        disabled={!loaded}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            if (dirty) void save(text);
          }
        }}
        maxLength={20000}
        placeholder="Routes, builds, where you left off, mods you like… (Ctrl+S to save)"
        className="min-h-[150px] w-full resize-y rounded-ctl border border-line bg-elevated p-3 text-sm leading-relaxed placeholder:text-muted/70 t-transition hover:border-line-strong focus:border-accent focus:outline-none"
      />
    </section>
  );
}

export function GameDetailPage() {
  const slug = useApp((s) => s.gameSlug);
  const game = useApp((s) => s.games.find((g) => g.slug === s.gameSlug));
  const sessions = useApp((s) => s.sessions);
  const setModal = useApp((s) => s.setModal);
  const navigate = useApp((s) => s.navigate);
  const refreshGames = useApp((s) => s.refreshGames);
  const live = sessions.some((s) => s.slug === slug && s.completionStatus === "active");
  const now = useNow(live, 1000);
  const mine = useMemo(() => sessions.filter((s) => s.slug === slug).sort((a, b) => b.startedAt - a.startedAt), [sessions, slug]);
  const stats = useMemo(() => gameStats(slug ?? "", sessions, now), [slug, sessions, now]);
  const [validating, setValidating] = useState(false);
  const [fetching, setFetching] = useState(false);
  const toast = useApp((s) => s.toast);
  const replaceGames = useApp((s) => s.refreshGames);

  if (!game) {
    return (
      <div className="page-pad">
        <EmptyState title="Game not found" action={<Button variant="primary" onClick={() => navigate("library")}>Back to library</Button>} />
      </div>
    );
  }

  return (
    <div>
      {/* Hero */}
      <section className="relative isolate overflow-hidden border-b border-line">
        <Artwork game={game} variant="hero" ratio="fill" titleSize="lg" className="!absolute inset-0" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/25" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg/80 to-transparent" />
        <div className="relative flex min-h-[320px] flex-col justify-end gap-5 p-[var(--pad)] pt-24">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <StatusBadge game={game} />
              {game.isFavourite && <Badge tone="accent">★ Favourite</Badge>}
              {game.source !== "catalog" && <Badge>{SOURCE_LABEL[game.source]}</Badge>}
            </div>
            <h1 className="display text-5xl font-bold leading-none drop-shadow-lg">{game.title}</h1>
            <p className="mt-2 text-[13px] text-muted">
              {stats.sessionCount > 0 ? `${formatDuration(stats.totalSecs)} played · last played ${relativeTime(stats.lastPlayedAt ?? now, now)}` : "Not played yet"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PlayButton game={game} size="lg" className="min-w-[170px]" />
            <FavouriteButton game={game} className="!h-12 !w-12 !bg-elevated border border-line" />
            <Button variant="secondary" icon={<ChartColumn size={16} />} onClick={() => navigate("stats")}>View statistics</Button>
            <Button variant="secondary" icon={<FolderOpen size={16} />} disabled={!game.installationPath && !game.launchTarget} onClick={() => void reveal("installation", game.slug)}>Open installation folder</Button>
            <Button variant="secondary" icon={<ImagePlus size={16} />} onClick={() => void chooseArtwork(game.slug)}>Edit artwork</Button>
            <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setModal({ type: "launchSettings", slug: game.slug })}>Edit launch settings</Button>
          </div>
        </div>
      </section>

      <div className="page-pad grid items-start gap-[var(--gap)] xl:grid-cols-2">
        {/* Installation */}
        <section className="panel p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="display text-lg font-semibold">Installation</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={<Link2 size={14} />} onClick={() => setModal({ type: "locate", slug: game.slug })}>{game.installed ? "Change installation" : "Locate installation"}</Button>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={validating} onClick={async () => { setValidating(true); await refreshGames(); setValidating(false); }}>Validate</Button>
              {game.launchTarget && <Button size="sm" variant="ghost" icon={<Unlink size={14} />} onClick={() => void unlink(game.slug)}>Unlink</Button>}
              {game.source !== "catalog" && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<EyeOff size={14} />}
                  onClick={async () => {
                    try {
                      await api.setGameHidden(game.slug, true);
                      toast("info", `${game.title} removed from your library`, "Restore it any time in Settings → Library.");
                      navigate("library");
                    } catch (e) {
                      toast("error", "Couldn't remove it", (e as Error).message);
                    }
                  }}
                >
                  Remove from library
                </Button>
              )}
            </div>
          </div>
          {game.launchTarget || game.installationPath ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><Info label="Installation path" mono value={game.installationPath ?? "—"} /></div>
              <div className="sm:col-span-2"><Info label="Launch target" mono value={game.launchTarget ?? "—"} /></div>
              <Info label="Launch method" value={METHOD_LABEL[game.launchMethod]} />
              <Info label="Status" value={<span className={game.installed ? "text-success" : "text-warning"}>{STATUS_TEXT[game.validationStatus]}</span>} />
              <Info label="Linked to launcher" value={game.linkedAt ? `${formatDate(game.linkedAt)} (${game.linkSource === "manual" ? "manually" : "auto-detected"})` : "—"} />
              <Info label="Last validated" value={game.lastValidatedAt ? formatDateTime(game.lastValidatedAt) : "—"} />
              {game.launchArgs && <div className="sm:col-span-2"><Info label="Launch arguments" mono value={game.launchArgs} /></div>}
              {game.validationMessage && !game.installed && <div className="sm:col-span-2 text-[13px] text-warning">{game.validationMessage}</div>}
            </div>
          ) : (
            <EmptyState compact title="Not linked yet">WIISB Launcher hasn't found this game. Locate its folder or executable and it will be remembered.</EmptyState>
          )}
        </section>

        {/* Activity */}
        <section className="panel p-5">
          <h2 className="display mb-4 text-lg font-semibold">Activity</h2>
          {mine.length === 0 ? (
            <EmptyState compact title="No sessions yet">Playtime appears here once the game is confirmed running.</EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Info label="Total playtime" value={formatDuration(stats.totalSecs)} />
                <Info label="Sessions" value={stats.sessionCount} />
                <Info label="Average session" value={formatDuration(stats.averageSecs)} />
                <Info label="Longest session" value={formatDuration(stats.longestSecs)} />
                <Info label="Most recent session" value={stats.lastSessionSecs !== null ? formatDuration(stats.lastSessionSecs) : "—"} />
                <Info label="Last played" value={stats.lastPlayedAt ? formatDateTime(stats.lastPlayedAt) : "—"} />
              </div>
              <h3 className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted">Recent sessions</h3>
              <ul className="divide-y divide-line">
                {mine.slice(0, 5).map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-2 text-[13px]">
                    <span>{formatDateTime(s.startedAt)}</span>
                    <span className="flex items-center gap-2">
                      {s.completionStatus === "active" && <Badge tone="success">Playing</Badge>}
                      {s.completionStatus === "recovered" && <Badge tone="warning">Recovered</Badge>}
                      <span className="font-semibold tabular-nums">{formatDuration(effectiveDuration(s, now))}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <div className="xl:col-span-2">
          <Notes slug={game.slug} />
        </div>

        <section className="panel flex flex-wrap items-center justify-between gap-3 p-5 xl:col-span-2">
          <div className="flex items-center gap-3">
            <Rocket size={20} className="text-accent2" />
            <div>
              <div className="text-sm font-semibold">Artwork</div>
              <div className="text-xs text-muted">{game.artworkPath ? "Cover image in use — fetched from Steam or chosen by you." : "Using a generated placeholder. Fetch a cover from Steam, or add your own PNG, JPG or WebP."}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<CloudDownload size={14} />}
              loading={fetching}
              onClick={async () => {
                setFetching(true);
                try {
                  await api.fetchArtwork(game.slug);
                  await replaceGames();
                  toast("success", "Cover updated from Steam");
                } catch (e) {
                  toast("error", "Couldn't get a cover", (e as Error).message);
                } finally {
                  setFetching(false);
                }
              }}
            >
              Fetch cover online
            </Button>
            <Button size="sm" variant="secondary" icon={<ImagePlus size={14} />} onClick={() => void chooseArtwork(game.slug)}>Choose image…</Button>
            {game.artworkPath && <Button size="sm" variant="ghost" onClick={() => void resetArtwork(game.slug)}>Reset</Button>}
          </div>
        </section>
      </div>
    </div>
  );
}
