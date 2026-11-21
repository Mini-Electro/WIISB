import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  Boxes,
  ChartColumn,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Heart,
  History,
  House,
  Info,
  LayoutGrid,
  LibraryBig,
  List,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Search,
  Settings as SettingsIcon,
  Square,
  X,
} from "lucide-react";
import { useApp } from "@/stores/appStore";
import { useMotionScale, useNow } from "@/hooks/hooks";
import { THEME_OPTIONS } from "@/utils/theme";
import { formatClock } from "@/utils/format";
import type { Page, SortKey } from "@/types";
import { Logo, Wordmark } from "./common";
import { Button, IconButton, Segmented, Select, Tooltip, cx } from "./ui";

/* ------------------------------------------------------------ Window controls */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    void win.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);
  const win = getCurrentWindow();
  const btn = "grid h-full w-12 place-items-center text-muted t-transition";
  return (
    <div className="-mr-3 ml-1 flex h-full">
      <button aria-label="Minimise" className={cx(btn, "wash hover:text-fg")} onClick={() => void win.minimize()}>
        <Minus size={16} />
      </button>
      <button aria-label={maximized ? "Restore" : "Maximise"} className={cx(btn, "wash hover:text-fg")} onClick={() => void win.toggleMaximize()}>
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
      {/* Closing goes through the native close handler, so close-to-tray / confirm-exit apply. */}
      <button aria-label="Close" className={cx(btn, "hover:bg-[#e5484d] hover:text-white")} onClick={() => void win.close()}>
        <X size={17} />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Theme menu */
function ThemeMenu() {
  const theme = useApp((s) => s.settings?.theme);
  const patch = useApp((s) => s.patchSettings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <IconButton label="Theme" active={open} onClick={() => setOpen((o) => !o)}>
        <Palette size={18} />
      </IconButton>
      {open && (
        <div className="panel-elevated absolute right-0 top-11 z-[90] max-h-[72vh] w-60 overflow-y-auto p-1.5 shadow-2xl">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                void patch({ theme: t.id, accentColor: null, backgroundColor: null, panelColor: null });
                setOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-ctl px-2.5 py-2 text-left text-sm font-medium wash grow-xs"
            >
              <span className="flex overflow-hidden rounded-md border border-line-strong">
                {t.swatch.map((c) => (
                  <span key={c} className="h-5 w-4" style={{ background: c }} />
                ))}
              </span>
              <span className="flex-1">{t.name}</span>
              {theme === t.id && <Check size={15} className="text-accent2" />}
            </button>
          ))}
          <div className="mt-1 border-t border-line px-2.5 pt-2 text-[11px] text-muted">Fine-tune colours in Settings → Appearance.</div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- TopBar */
const TITLES: Record<Page, string> = {
  home: "Home",
  library: "Library",
  recent: "Recently Played",
  favourites: "Favourites",
  stats: "Statistics",
  other: "Other WIISB's",
  settings: "Settings",
  game: "Game",
};

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "lastPlayed", label: "Last played" },
  { value: "playtime", label: "Playtime" },
  { value: "added", label: "Recently added" },
];

export function TopBar() {
  const page = useApp((s) => s.page);
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const navigate = useApp((s) => s.navigate);
  const goBack = useApp((s) => s.goBack);
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const game = useApp((s) => s.games.find((g) => g.slug === s.gameSlug));
  const inputRef = useRef<HTMLInputElement>(null);
  const showView = page === "library" || page === "favourites";

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("wiisb:focus-search", focus);
    return () => window.removeEventListener("wiisb:focus-search", focus);
  }, []);

  return (
    <header data-tauri-drag-region className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-5 backdrop-blur">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {page === "game" && (
          <IconButton label="Back (Alt+←)" onClick={goBack}>
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <h1 data-tauri-drag-region className="display truncate text-[17px] font-semibold tracking-wide">
          {page === "game" ? (game?.title ?? "Game") : TITLES[page]}
        </h1>
      </div>

      <div data-tauri-drag-region className="flex-1" />

      {showView && settings && (
        <>
          <Select
            label="Sort by"
            value={settings.sortBy}
            options={SORT_OPTIONS}
            onChange={(v) => void patch({ sortBy: v })}
            className="!h-9 hidden text-[13px] xl:block"
          />
          <Segmented
            label="View"
            value={settings.viewMode}
            onChange={(v) => void patch({ viewMode: v })}
            options={[
              { value: "grid", label: <LayoutGrid size={15} />, title: "Grid view" },
              { value: "list", label: <List size={15} />, title: "List view" },
            ]}
          />
        </>
      )}

      <label className="relative w-60 max-w-[30vw]">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search games  (Ctrl+K)"
          aria-label="Search games"
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value && !["library", "favourites", "recent"].includes(page)) navigate("library");
          }}
          onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
          className="h-9 w-full rounded-ctl border border-line bg-elevated pl-9 pr-3 text-[13px] placeholder:text-muted/70 t-transition hover:border-line-strong focus:border-accent focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </label>

      <ThemeMenu />
      <IconButton label="Settings (Ctrl+,)" active={page === "settings"} onClick={() => navigate("settings")}>
        <SettingsIcon size={18} />
      </IconButton>
      <WindowControls />
    </header>
  );
}

/* -------------------------------------------------------------------- Sidebar */
const NAV: { page: Page; label: string; icon: typeof House }[] = [
  { page: "home", label: "Home", icon: House },
  { page: "library", label: "Library", icon: LibraryBig },
  { page: "recent", label: "Recently Played", icon: History },
  { page: "favourites", label: "Favourites", icon: Heart },
  { page: "stats", label: "Statistics", icon: ChartColumn },
  { page: "other", label: "Other WIISB's", icon: Boxes },
  { page: "settings", label: "Settings", icon: SettingsIcon },
];

export function Sidebar() {
  const page = useApp((s) => s.page);
  const navigate = useApp((s) => s.navigate);
  const collapsed = useApp((s) => s.settings?.sidebarCollapsed ?? false);
  const patch = useApp((s) => s.patchSettings);
  const library = useApp((s) => s.library);
  const runtime = useApp((s) => s.runtime);
  const games = useApp((s) => s.games);
  const running = useMemo(() => Object.values(runtime).find((r) => r.state === "running"), [runtime]);
  const runningGame = games.find((g) => g.slug === running?.slug);
  const now = useNow(!!running, 1000);
  const scale = useMotionScale();

  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 244 }}
      transition={{ duration: 0.25 * scale, ease: [0.2, 0.7, 0.2, 1] }}
      className="relative z-30 flex shrink-0 flex-col border-r border-line bg-surface"
    >
      <div data-tauri-drag-region className={cx("flex h-14 items-center gap-3 border-b border-line", collapsed ? "justify-center" : "px-5")}>
        <Logo size={32} />
        {!collapsed && <Wordmark />}
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main">
        {NAV.filter((n) => n.page !== "settings").map(({ page: p, label, icon: Icon }) => {
          const active = page === p || (page === "game" && p === "library");
          const btn = (
            <button
              key={p}
              onClick={() => navigate(p)}
              aria-current={active ? "page" : undefined}
              className={cx(
                "relative flex h-11 w-full items-center gap-3 rounded-ctl text-sm font-semibold t-transition grow-sm",
                collapsed ? "justify-center" : "px-3.5",
                active ? "bg-accent/15 text-fg" : "text-muted wash hover:text-fg",
              )}
            >
              {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-accent" />}
              <Icon size={19} className={active ? "text-accent2" : undefined} />
              {!collapsed && <span>{label}</span>}
            </button>
          );
          return collapsed ? (
            <Tooltip key={p} label={label} side="right">
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        {running && runningGame && (
          <button
            onClick={() => navigate("game", runningGame.slug)}
            className={cx("panel-elevated flex w-full items-center gap-2.5 p-2.5 text-left t-transition hover:border-success/50", collapsed && "justify-center")}
            title={`${runningGame.title} is running`}
          >
            <span className="pulse-ring h-2.5 w-2.5 shrink-0 rounded-full bg-success" />
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">{runningGame.title}</span>
                <span className="block text-[11px] text-success">Playing · {running.startedAt ? formatClock(now - running.startedAt) : "…"}</span>
              </span>
            )}
          </button>
        )}

        <div className={cx("flex items-center gap-2 px-1 text-xs", collapsed ? "justify-center" : "")} title={library?.message ?? "Library folder reachable"}>
          <span className={cx("h-2 w-2 shrink-0 rounded-full", library?.available ? "bg-success" : "bg-danger")} />
          {!collapsed && <span className="truncate text-muted">{library?.available ? "Library online" : "Library drive offline"}</span>}
        </div>

        <div className={cx("flex gap-1", collapsed ? "flex-col items-center" : "items-center")}>
          {collapsed ? (
            <Tooltip label="Settings" side="right">
              <button onClick={() => navigate("settings")} className={cx("grid h-10 w-10 place-items-center rounded-ctl t-transition wash", page === "settings" ? "bg-accent/15 text-accent2" : "text-muted hover:text-fg")} aria-label="Settings">
                <SettingsIcon size={19} />
              </button>
            </Tooltip>
          ) : (
            <button onClick={() => navigate("settings")} aria-current={page === "settings" ? "page" : undefined} className={cx("flex h-10 flex-1 items-center gap-3 rounded-ctl px-3.5 text-sm font-semibold t-transition", page === "settings" ? "bg-accent/15 text-fg" : "text-muted wash hover:text-fg")}>
              <SettingsIcon size={19} className={page === "settings" ? "text-accent2" : undefined} />
              Settings
            </button>
          )}
          <IconButton label={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"} tooltipSide={collapsed ? "right" : "top"} onClick={() => void patch({ sidebarCollapsed: !collapsed })}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
        </div>
      </div>
    </motion.aside>
  );
}

/* ------------------------------------------------------------------- Banners */
export function Banners() {
  const library = useApp((s) => s.library);
  const dbRecovery = useApp((s) => s.dbRecovery);
  const retry = useApp((s) => s.retryLibrary);
  const choose = useApp((s) => s.chooseLibraryRoot);
  const navigate = useApp((s) => s.navigate);
  const [hideDb, setHideDb] = useState(false);
  return (
    <>
      {library && !library.available && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-danger/30 bg-danger/10 px-5 py-2.5 text-sm">
          <CircleAlert size={18} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-medium">{library.message ?? "Your game library drive could not be accessed."}</span>
          <Button size="sm" variant="secondary" onClick={() => void retry()}>
            Retry
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void choose()}>
            Change library folder
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate("settings")}>
            Open settings
          </Button>
        </div>
      )}
      {dbRecovery && !hideDb && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2.5 text-sm">
          <Info size={18} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            The launcher database couldn't be opened, so a fresh one was created. Your original data was kept at <span className="font-mono text-xs">{dbRecovery.preservedAt}</span>.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setHideDb(true)}>
            Dismiss
          </Button>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- Toasts */
export function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const scale = useMotionScale();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[120] flex w-[360px] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 40 * scale, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 * scale }}
            transition={{ duration: 0.22 * scale }}
            className="glass pointer-events-auto flex items-start gap-3 rounded-card p-3.5 shadow-2xl"
            role={t.kind === "error" ? "alert" : "status"}
          >
            {t.kind === "error" ? <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" /> : t.kind === "success" ? <CircleCheck size={18} className="mt-0.5 shrink-0 text-success" /> : <Info size={18} className="mt-0.5 shrink-0 text-accent2" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-snug">{t.title}</div>
              {t.message && <div className="mt-0.5 break-words text-[13px] leading-snug text-muted">{t.message}</div>}
            </div>
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-fg">
              <X size={15} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
