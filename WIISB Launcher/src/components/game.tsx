import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { FolderSearch, Heart, Play, Square } from "lucide-react";
import { useApp } from "@/stores/appStore";
import { useMotionScale, useNow } from "@/hooks/hooks";
import { artworkUrl, placeholderGradient } from "@/utils/artwork";
import { formatClock, formatDuration, relativeTime } from "@/utils/format";
import { summarize, type GameStats } from "@/utils/stats";
import { SOURCE_LABEL } from "@/utils/library";
import type { Game } from "@/types";
import { Badge, Button, cx } from "./ui";

/* ------------------------------------------------------------ Per-game stats */
/** Stats for every game, recomputed when sessions change (and every 15s while a session is live). */
export function useGameStats(): Record<string, GameStats> {
  const games = useApp((s) => s.games);
  const sessions = useApp((s) => s.sessions);
  const live = sessions.some((s) => s.completionStatus === "active");
  const now = useNow(live, 15000);
  return useMemo(() => Object.fromEntries(summarize(sessions, games, now).perGame.map((g) => [g.slug, g])), [games, sessions, now]);
}

/* ------------------------------------------------------------------- Artwork */
const RATIO = { poster: "2 / 3", landscape: "16 / 9", square: "1 / 1" } as const;

export function Artwork({
  game,
  variant = "cover",
  ratio,
  className,
  children,
  titleSize = "md",
}: {
  game: Pick<Game, "slug" | "title" | "artworkPath"> & Partial<Pick<Game, "heroPath" | "iconPath">>;
  /** "hero" prefers the wide banner (falls back to the cover). */
  variant?: "cover" | "hero";
  /** Overrides the user's artwork-style setting; "fill" stretches to the parent. */
  ratio?: keyof typeof RATIO | "fill";
  className?: string;
  children?: ReactNode;
  titleSize?: "sm" | "md" | "lg";
}) {
  const style = useApp((s) => s.settings?.artworkStyle ?? "poster");
  const [failedPath, setFailedPath] = useState<string | null>(null);
  // Wide images (Steam's landscape headers) in a tall slot are shown whole over a blurred copy, not cropped to a sliver.
  const [wideFor, setWideFor] = useState<string | null>(null);
  const path = variant === "hero" ? (game.heroPath ?? game.artworkPath) : game.artworkPath;
  const url = path && failedPath !== path ? artworkUrl(path) : null;
  const iconUrl = !url && game.iconPath ? artworkUrl(game.iconPath) : null;
  const r = ratio ?? style;
  return (
    <div
      className={cx("relative isolate overflow-hidden bg-elevated", className)}
      style={r === "fill" ? undefined : { aspectRatio: RATIO[r] }}
    >
      {url ? (
        <>
          {wideFor === path && r !== "landscape" && r !== "fill" && (
            <img src={url} alt="" aria-hidden draggable={false} className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70 blur-2xl" />
          )}
          <img
            src={url}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setFailedPath(path)}
            onLoad={(e) => setWideFor(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight) > 1.25 ? path : null)}
            className={cx("absolute inset-0 h-full w-full", wideFor === path && r !== "landscape" && r !== "fill" ? "object-contain" : "object-cover")}
          />
        </>
      ) : (
        <div className="absolute inset-0" style={{ background: placeholderGradient(game.slug, game.title) }}>
          <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "repeating-linear-gradient(135deg, #fff 0 1px, transparent 1px 14px)" }} />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
            {iconUrl && (
              <img src={iconUrl} alt="" draggable={false} className={cx("object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,.55)]", titleSize === "sm" ? "h-8 w-8" : titleSize === "lg" ? "h-24 w-24" : "h-16 w-16")} />
            )}
            <span
              className={cx(
                "display text-center font-bold leading-[1.05] tracking-wide text-white/90 [text-shadow:0_2px_24px_rgba(0,0,0,.45)] [overflow-wrap:anywhere]",
                titleSize === "lg" ? "text-5xl" : titleSize === "sm" ? "text-base" : "text-2xl",
              )}
            >
              {game.title}
            </span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- PlayButton */
export function PlayButton({ game, size = "md", className }: { game: Game; size?: "sm" | "md" | "lg"; className?: string }) {
  const rt = useApp((s) => s.runtime[game.slug]);
  const requestLaunch = useApp((s) => s.requestLaunch);
  const setModal = useApp((s) => s.setModal);
  const state = rt?.state ?? "idle";
  const now = useNow(state === "running", 1000);
  const label = "display tracking-[0.14em] uppercase";

  if (!game.installed) {
    return (
      <Button size={size} variant="secondary" className={cx(label, className)} icon={<FolderSearch size={16} />} onClick={() => setModal({ type: "locate", slug: game.slug })}>
        Locate
      </Button>
    );
  }
  // While a game is launching or running there is always a way out: Force stop ends it (after a confirmation).
  const stop = (
    <Button
      size={size}
      variant="danger"
      aria-label={`Force stop ${game.title}`}
      title="Force stop"
      className="shrink-0 !px-3"
      icon={<Square size={14} fill="currentColor" />}
      onClick={(e) => {
        e.stopPropagation();
        setModal({ type: "confirmStop", slug: game.slug });
      }}
    />
  );
  if (state === "launching") {
    return (
      <div className={cx("flex gap-2", className)}>
        <Button size={size} variant="primary" loading disabled className={cx(label, "flex-1")}>
          Launching
        </Button>
        {stop}
      </div>
    );
  }
  if (state === "running") {
    return (
      <div className={cx("flex gap-2", className)}>
        <Button size={size} variant="success" disabled className={cx(label, "flex-1 !opacity-100")} icon={<span className="pulse-ring h-2.5 w-2.5 rounded-full bg-success" />}>
          Running{rt?.startedAt ? ` · ${formatClock(now - rt.startedAt)}` : ""}
        </Button>
        {stop}
      </div>
    );
  }
  if (state === "launch_requested") {
    return (
      <Button size={size} variant="secondary" disabled className={cx(label, className)} title={rt?.message ?? undefined}>
        Launch requested
      </Button>
    );
  }
  return (
    <Button size={size} variant="primary" className={cx(label, className)} icon={<Play size={size === "sm" ? 14 : 16} fill="currentColor" />} onClick={() => requestLaunch(game.slug)}>
      Play
    </Button>
  );
}

export function FavouriteButton({ game, className }: { game: Game; className?: string }) {
  const toggle = useApp((s) => s.toggleFavourite);
  return (
    <button
      type="button"
      aria-label={game.isFavourite ? `Remove ${game.title} from favourites` : `Add ${game.title} to favourites`}
      aria-pressed={game.isFavourite}
      onClick={(e) => {
        e.stopPropagation();
        void toggle(game.slug);
      }}
      className={cx("grid h-9 w-9 place-items-center rounded-full t-transition grow-lg", game.isFavourite ? "bg-black/50 text-[#ff5c8a]" : "bg-black/45 text-white/80 hover:text-white", className)}
    >
      <Heart size={17} fill={game.isFavourite ? "currentColor" : "none"} />
    </button>
  );
}

export function StatusBadge({ game }: { game: Game }) {
  if (game.installed) return <Badge tone="success">● Installed</Badge>;
  if (game.validationStatus === "not_linked") return <Badge tone="warning">Not Found</Badge>;
  if (game.validationStatus === "drive_unavailable") return <Badge tone="danger">Drive offline</Badge>;
  return <Badge tone="danger">Needs attention</Badge>;
}

const onKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/* ------------------------------------------------------------------ GameCard */
export function GameCard({ game, stats, index = 0 }: { game: Game; stats?: GameStats; index?: number }) {
  const openGame = useApp((s) => s.openGame);
  const scale = useMotionScale();
  const now = useNow(false);
  const open = () => openGame(game.slug);
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 * scale }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 * scale, delay: Math.min(index * 0.05, 0.3) * scale, ease: [0.2, 0.7, 0.2, 1] }}
      className="group cursor-pointer outline-none"
      role="link"
      tabIndex={0}
      aria-label={game.title}
      onClick={open}
      onKeyDown={onKey(open)}
    >
      <Artwork
        game={game}
        className="card-grow rounded-card border border-line t-transition group-hover:-translate-y-1 group-hover:border-accent/60 group-hover:shadow-glow group-focus-visible:border-accent"
      >
        <div className="on-art absolute left-2.5 top-2.5 z-10">
          <StatusBadge game={game} />
        </div>
        <FavouriteButton game={game} className={cx("absolute right-2.5 top-2.5 z-10", !game.isFavourite && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")} />
        <div className="absolute inset-x-0 bottom-0 z-10 translate-y-2 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-3 pt-10 opacity-0 t-transition group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
          <div onClick={(e) => e.stopPropagation()}>
            <PlayButton game={game} size="md" className="w-full" />
          </div>
        </div>
      </Artwork>
      <div className="mt-3 px-0.5">
        <div className="display truncate text-[17px] font-semibold leading-tight">{game.title}</div>
        <div className="mt-0.5 truncate text-xs text-muted">
          {game.source !== "catalog" && <span className="font-medium text-accent2">{SOURCE_LABEL[game.source]} · </span>}
          {stats && stats.sessionCount > 0 ? `${formatDuration(stats.totalSecs)} played${stats.lastPlayedAt ? ` · ${relativeTime(stats.lastPlayedAt, now)}` : ""}` : "Not played yet"}
        </div>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------- GameRow */
export function GameRow({ game, stats }: { game: Game; stats?: GameStats }) {
  const openGame = useApp((s) => s.openGame);
  const now = useNow(false);
  const open = () => openGame(game.slug);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={game.title}
      onClick={open}
      onKeyDown={onKey(open)}
      className="panel group grow-xs flex cursor-pointer items-center gap-4 p-2.5 pr-4 t-transition hover:border-accent/50 hover:bg-elevated"
    >
      <Artwork game={game} ratio="square" titleSize="sm" className="h-14 w-14 shrink-0 rounded-ctl" />
      <div className="min-w-0 flex-1">
        <div className="display truncate text-base font-semibold">{game.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          <StatusBadge game={game} />
          {game.source !== "catalog" && <span>{SOURCE_LABEL[game.source]}</span>}
        </div>
      </div>
      <div className="hidden w-32 text-right text-[13px] md:block">
        <div className="font-semibold">{stats && stats.sessionCount ? formatDuration(stats.totalSecs) : "—"}</div>
        <div className="text-xs text-muted">playtime</div>
      </div>
      <div className="hidden w-36 text-right text-[13px] lg:block">
        <div className="font-semibold">{stats?.lastPlayedAt ? relativeTime(stats.lastPlayedAt, now) : "Never"}</div>
        <div className="text-xs text-muted">last played</div>
      </div>
      <FavouriteButton game={game} className={cx(!game.isFavourite && "!bg-transparent")} />
      <div onClick={(e) => e.stopPropagation()}>
        <PlayButton game={game} size="sm" className="min-w-[116px]" />
      </div>
    </div>
  );
}
