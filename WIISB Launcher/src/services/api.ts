// Thin, typed wrapper around the native commands. Nothing here touches the filesystem or
// starts processes directly — everything goes through the validated Rust backend.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  UpdateCheck,
  OtherUpdate,
  DeepStatus,
  DetectedItem,
  AppSettings,
  Bootstrap,
  Game,
  LaunchEntry,
  LaunchSettingsInput,
  LibraryStatus,
  LinkResult,
  DeepProgress,
  RuntimeSnapshot,
  ScanReport,
  Session,
  OtherApp,
} from "@/types";

export class AppError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as { code: string; message: string };
    return new AppError(o.code, o.message);
  }
  return new AppError("unknown", typeof e === "string" ? e : "Something went wrong.");
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const api = {
  bootstrap: () => call<Bootstrap>("bootstrap"),
  otherApps: () => call<OtherApp[]>("other_apps"),
  launchOtherApp: (id: string) => call<void>("launch_other_app", { id }),
  installOtherApp: (id: string) => call<OtherApp>("install_other_app", { id }),
  locateOtherApp: (id: string, path: string) => call<OtherApp>("locate_other_app", { id, path }),
  checkOtherUpdates: () => call<OtherUpdate[]>("check_other_updates"),
  updateOtherApp: (id: string) => call<OtherApp>("update_other_app", { id }),
  otherAppStartDir: (id: string) => call<string | null>("other_app_start_dir", { id }),
  locateStartDir: (slug: string) => call<string | null>("locate_start_dir", { slug }),
  checkForUpdates: () => call<UpdateCheck>("check_for_updates"),
  revealOtherApp: (id: string) => call<void>("reveal_other_app", { id }),
  forgetOtherAppPath: (id: string) => call<void>("forget_other_app_path", { id }),
  updateSettings: (patch: Partial<AppSettings>) => call<AppSettings>("update_settings", { patch }),
  appInfo: () => call<AppInfo>("get_app_info"),
  quit: () => call<void>("quit_app"),
  hideToTray: () => call<void>("hide_to_tray"),
  reveal: (kind: "installation" | "working_dir" | "library_root" | "data" | "logs", slug?: string) =>
    call<void>("reveal_path", { kind, slug: slug ?? null }),

  libraryStatus: () => call<LibraryStatus>("get_library_status"),
  scanLibrary: (force = false) => call<ScanReport>("scan_library", { force }),
  setLibraryRoot: (path: string) => call<LibraryStatus>("set_library_root", { path }),
  linkGame: (slug: string, path: string, installDir?: string) =>
    call<LinkResult>("link_game", { slug, path, installDir: installDir ?? null }),
  unlinkGame: (slug: string) => call<Game>("unlink_game", { slug }),
  saveLaunchSettings: (slug: string, input: LaunchSettingsInput) => call<Game>("save_launch_settings", { slug, input }),
  validateGames: () => call<Game[]>("validate_games"),
  setFavourite: (slug: string, favourite: boolean) => call<Game>("set_favourite", { slug, favourite }),
  getNotes: (slug: string) => call<string>("get_notes", { slug }),
  setNotes: (slug: string, body: string) => call<void>("set_notes", { slug, body }),
  setArtwork: (slug: string, sourcePath: string) => call<Game>("set_artwork", { slug, sourcePath }),
  clearArtwork: (slug: string) => call<Game>("clear_artwork", { slug }),
  addCustomGame: (title: string, exePath: string) => call<Game>("add_custom_game", { title, exePath }),
  setGameHidden: (slug: string, hidden: boolean) => call<void>("set_game_hidden", { slug, hidden }),
  hiddenGames: () => call<Game[]>("list_hidden_games"),
  fetchArtwork: (slug?: string) => call<Game[]>("fetch_artwork", { slug: slug ?? null }),
  detectGames: () => call<DetectedItem[]>("detect_games"),
  deepScanStart: () => call<void>("deep_scan_start"),
  deepScanCancel: () => call<void>("deep_scan_cancel"),
  deepScanStatus: () => call<DeepStatus>("deep_scan_status"),
  deepScanAdd: (ids: string[]) => call<DetectedItem[]>("deep_scan_add", { ids }),

  launch: (slug: string) => call<RuntimeSnapshot>("launch_game", { slug }),
  stop: (slug: string) => call<void>("stop_game", { slug }),
  runtime: () => call<RuntimeSnapshot[]>("get_runtime"),
  detectRunning: () => call<RuntimeSnapshot[]>("detect_running_games"),

  sessions: (since?: number) => call<Session[]>("list_sessions", { since: since ?? null }),
  launches: (limit = 50) => call<LaunchEntry[]>("list_launch_history", { limit }),
  exportCsv: (path: string) => call<number>("export_sessions_csv", { path }),
  resetStats: (confirm: string) => call<void>("reset_statistics", { confirm }),
};

export type EventMap = {
  "game-state": RuntimeSnapshot;
  "sessions-changed": null;
  "library-changed": Game[];
  "settings-changed": AppSettings;
  navigate: string;
  "confirm-exit": null;
  notice: { kind: "error" | "info"; message: string };
  "deep-scan-progress": DeepProgress;
  "deep-scan-done": DeepStatus;
};

export function on<K extends keyof EventMap>(name: K, handler: (payload: EventMap[K]) => void): Promise<UnlistenFn> {
  return listen<EventMap[K]>(name, (e) => handler(e.payload));
}
