import { create } from "zustand";
import { api, AppError, on } from "@/services/api";
import { pickFolder } from "@/services/dialogs";
import type {
  AppInfo,
  AppSettings,
  Candidate,
  DeepStatus,
  Game,
  LibraryStatus,
  Page,
  Recovery,
  RuntimeSnapshot,
  ScanReport,
  Session,
  ToastItem,
} from "@/types";

export type Modal =
  | null
  | { type: "locate"; slug: string }
  | { type: "candidates"; slug: string; candidates: Candidate[] }
  | { type: "scan"; report: ScanReport }
  | { type: "confirmLaunch"; slug: string }
  | { type: "confirmStop"; slug: string }
  | { type: "confirmExit" }
  | { type: "addGame" }
  | { type: "deepScan" }
  | { type: "launchSettings"; slug: string }
  | { type: "launchError"; slug: string; code: string; message: string };

interface HistoryEntry {
  page: Page;
  slug: string | null;
}

interface Store {
  ready: boolean;
  bootError: string | null;
  games: Game[];
  settings: AppSettings | null;
  runtime: Record<string, RuntimeSnapshot>;
  sessions: Session[];
  library: LibraryStatus | null;
  appInfo: AppInfo | null;
  dbRecovery: Recovery | null;
  scanning: boolean;
  deep: DeepStatus | null;

  page: Page;
  gameSlug: string | null;
  history: HistoryEntry[];
  query: string;
  favouritesOnly: boolean;
  installedOnly: boolean;
  sourceFilter: string;
  toasts: ToastItem[];
  modal: Modal;

  init: () => Promise<void>;
  navigate: (page: Page, slug?: string | null) => void;
  openGame: (slug: string) => void;
  goBack: () => void;
  setQuery: (q: string) => void;
  setFilters: (f: { favouritesOnly?: boolean; installedOnly?: boolean; sourceFilter?: string }) => void;
  toast: (kind: ToastItem["kind"], title: string, message?: string) => void;
  dismissToast: (id: number) => void;
  setModal: (m: Modal) => void;

  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  refreshGames: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  scan: (force?: boolean, opts?: { silent?: boolean }) => Promise<ScanReport | null>;
  openDeepScan: () => Promise<void>;
  startDeepScan: () => Promise<void>;
  cancelDeepScan: () => Promise<void>;
  chooseLibraryRoot: () => Promise<void>;
  retryLibrary: () => Promise<void>;
  requestLaunch: (slug: string) => void;
  stopGame: (slug: string) => Promise<void>;
  launch: (slug: string) => Promise<void>;
  toggleFavourite: (slug: string) => Promise<void>;
  replaceGame: (g: Game) => void;
}

let toastId = 1;
const clearTimers = new Map<string, number>();
let listenersReady = false;

const upsert = (games: Game[], g: Game) => games.map((x) => (x.slug === g.slug ? g : x));

export const useApp = create<Store>((set, get) => ({
  ready: false,
  bootError: null,
  games: [],
  settings: null,
  runtime: {},
  sessions: [],
  library: null,
  appInfo: null,
  dbRecovery: null,
  scanning: false,
  deep: null,

  page: "home",
  gameSlug: null,
  history: [],
  query: "",
  favouritesOnly: false,
  installedOnly: false,
  sourceFilter: "all",
  toasts: [],
  modal: null,

  async init() {
    try {
      if (!listenersReady) {
        listenersReady = true;
        await Promise.all([
          on("game-state", (snap) => {
            set((s) => {
              const runtime = { ...s.runtime };
              if (snap.state === "idle") delete runtime[snap.slug];
              else runtime[snap.slug] = snap;
              return { runtime };
            });
            const game = get().games.find((g) => g.slug === snap.slug);
            if (snap.state === "idle" && snap.message) get().toast("error", `${game?.title ?? "Game"} didn't start`, snap.message);
            if (snap.state === "launch_requested") {
              get().toast("info", `${game?.title ?? "Game"}: launch requested`, snap.message ?? undefined);
              window.clearTimeout(clearTimers.get(snap.slug));
              clearTimers.set(
                snap.slug,
                window.setTimeout(() => {
                  set((s) => {
                    const runtime = { ...s.runtime };
                    if (runtime[snap.slug]?.state === "launch_requested") delete runtime[snap.slug];
                    return { runtime };
                  });
                }, 8000),
              );
            }
          }),
          on("sessions-changed", () => void get().refreshSessions()),
          on("library-changed", (games) => set({ games })),
          on("settings-changed", (settings) => set({ settings })),
          on("navigate", (p) => {
            // Command-line shortcuts: `--scan-pc` opens the whole-PC scan dialog and starts it.
            if (p === "deepscan-start") {
              void get().openDeepScan().then(() => (get().deep?.running ? undefined : get().startDeepScan()));
            } else get().navigate((p as Page) || "home");
          }),
          on("confirm-exit", () => set({ modal: { type: "confirmExit" } })),
          on("notice", (n) => get().toast(n.kind === "error" ? "error" : "info", n.message)),
          on("deep-scan-progress", (progress) => set((s) => (s.deep ? { deep: { ...s.deep, running: true, progress } } : s))),
          on("deep-scan-done", (deep) => set({ deep })),
        ]);
      }
      const b = await api.bootstrap();
      const sessions = await api.sessions();
      set({
        games: b.games,
        settings: b.settings,
        library: b.library,
        appInfo: b.app,
        dbRecovery: b.dbRecovery,
        sessions,
        runtime: Object.fromEntries(b.runtime.map((r) => [r.slug, r])),
        ready: true,
        bootError: null,
      });
      if (b.firstRun && b.library.available) {
        // First launch: look for the four games and show what was found.
        void get().scan(false);
      }
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  navigate(page, slug = null) {
    const { page: cur, gameSlug, history } = get();
    if (cur === page && gameSlug === slug) return;
    set({ page, gameSlug: slug, history: [...history, { page: cur, slug: gameSlug }].slice(-30) });
  },
  openGame(slug) {
    get().navigate("game", slug);
  },
  goBack() {
    const { history } = get();
    const prev = history[history.length - 1];
    if (!prev) return set({ page: "library", gameSlug: null });
    set({ page: prev.page, gameSlug: prev.slug, history: history.slice(0, -1) });
  },
  setQuery(q) {
    set({ query: q });
  },
  setFilters(f) {
    set(f);
  },
  toast(kind, title, message) {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, message }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 4500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setModal(m) {
    set({ modal: m });
  },

  async patchSettings(patch) {
    const prev = get().settings;
    if (!prev) return;
    set({ settings: { ...prev, ...patch } }); // optimistic so appearance changes feel instant
    try {
      const saved = await api.updateSettings(patch);
      set({ settings: saved });
    } catch (e) {
      set({ settings: prev });
      get().toast("error", "Couldn't save setting", (e as Error).message);
    }
  },

  async refreshGames() {
    try {
      set({ games: await api.validateGames() });
    } catch (e) {
      get().toast("error", "Couldn't refresh the library", (e as Error).message);
    }
  },

  async refreshSessions() {
    try {
      set({ sessions: await api.sessions() });
    } catch {
      /* the next event will retry */
    }
  },

  async scan(force = false, opts = {}) {
    if (get().scanning) return null;
    set({ scanning: true });
    try {
      const report = await api.scanLibrary(force);
      const [games, library] = await Promise.all([api.validateGames(), api.libraryStatus()]);
      set({ games, library });
      if (!opts.silent) set({ modal: { type: "scan", report } });
      return report;
    } catch (e) {
      const err = e as AppError;
      set({ library: await api.libraryStatus().catch(() => get().library) });
      get().toast("error", err.code === "drive_unavailable" ? "Library drive unavailable" : "Scan failed", err.message);
      return null;
    } finally {
      set({ scanning: false });
    }
  },

  async openDeepScan() {
    try {
      set({ deep: await api.deepScanStatus(), modal: { type: "deepScan" } });
    } catch (e) {
      get().toast("error", "Couldn't open the scanner", (e as Error).message);
    }
  },

  async startDeepScan() {
    try {
      await api.deepScanStart();
      set({ deep: { running: true, finished: false, cancelled: false, hitLimit: false, progress: { dirs: 0, found: 0, current: "", elapsedSecs: 0 }, candidates: [] } });
    } catch (e) {
      get().toast("error", "Couldn't start the scan", (e as Error).message);
    }
  },

  async cancelDeepScan() {
    await api.deepScanCancel().catch(() => {});
  },

  async chooseLibraryRoot() {
    try {
      const picked = await pickFolder("Choose your game library folder", get().settings?.libraryRoot);
      if (!picked) return;
      const library = await api.setLibraryRoot(picked);
      set({ library, settings: get().settings ? { ...get().settings!, libraryRoot: picked } : null });
      get().toast("success", "Library folder updated", picked);
      await get().scan(false);
    } catch (e) {
      get().toast("error", "Couldn't use that folder", (e as Error).message);
    }
  },

  async retryLibrary() {
    try {
      const library = await api.libraryStatus();
      set({ library });
      if (library.available) {
        get().toast("success", "Library drive is back");
        await get().refreshGames();
      } else {
        get().toast("error", "Still can't reach the library", library.message ?? undefined);
      }
    } catch (e) {
      get().toast("error", "Retry failed", (e as Error).message);
    }
  },

  requestLaunch(slug) {
    const { settings, games } = get();
    const game = games.find((g) => g.slug === slug);
    if (!game) return;
    if (!game.installed) return set({ modal: { type: "locate", slug } });
    if (settings?.confirmBeforeLaunch) return set({ modal: { type: "confirmLaunch", slug } });
    void get().launch(slug);
  },

  async stopGame(slug) {
    const game = get().games.find((g) => g.slug === slug);
    try {
      await api.stop(slug);
      set((s) => {
        const runtime = { ...s.runtime };
        delete runtime[slug];
        return { runtime };
      });
      get().toast("success", `${game?.title ?? "Game"} was stopped`);
    } catch (e) {
      get().toast("error", `Couldn't stop ${game?.title ?? "the game"}`, (e as Error).message);
    }
  },

  async launch(slug) {
    const { runtime, games } = get();
    const game = games.find((g) => g.slug === slug);
    if (!game || (runtime[slug] && runtime[slug].state !== "launch_requested")) return;
    set((s) => ({
      runtime: { ...s.runtime, [slug]: { slug, state: "launching", pid: null, sessionId: null, startedAt: null, message: null } },
    }));
    try {
      const snap = await api.launch(slug);
      set((s) => (s.runtime[slug] ? { runtime: { ...s.runtime, [slug]: snap } } : s));
    } catch (e) {
      const err = e as AppError;
      set((s) => {
        const runtime = { ...s.runtime };
        if (err.code !== "already_running") delete runtime[slug];
        return { runtime };
      });
      if (err.code === "already_running") {
        get().toast("info", err.message);
      } else if (err.code === "launch_failed") {
        set({ modal: { type: "launchError", slug, code: err.code, message: err.message } });
      } else {
        // Validation changed on the backend (missing exe / drive gone) — pull the fresh status.
        void get().refreshGames();
        set({ modal: { type: "launchError", slug, code: err.code, message: err.message } });
      }
    }
  },

  async toggleFavourite(slug) {
    const game = get().games.find((g) => g.slug === slug);
    if (!game) return;
    const next = !game.isFavourite;
    set((s) => ({ games: upsert(s.games, { ...game, isFavourite: next }) }));
    try {
      get().replaceGame(await api.setFavourite(slug, next));
    } catch (e) {
      set((s) => ({ games: upsert(s.games, game) }));
      get().toast("error", "Couldn't update favourite", (e as Error).message);
    }
  },

  replaceGame(g) {
    set((s) => ({ games: upsert(s.games, g) }));
  },
}));

export const selectGame = (slug: string | null) => (s: Store) => s.games.find((g) => g.slug === slug) ?? null;
