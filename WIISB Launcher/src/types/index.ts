// Shapes shared with the Rust backend (serde camelCase). Keep in sync with src-tauri/src.

export type LaunchMethod = "direct" | "platform" | "shortcut";
export type ValidationStatus = "ok" | "missing" | "invalid" | "not_linked" | "drive_unavailable";

export interface Game {
  id: number;
  slug: string;
  title: string;
  sortOrder: number;
  addedAt: number;
  isFavourite: boolean;
  artworkPath: string | null;
  installationPath: string | null;
  launchTarget: string | null;
  launchMethod: LaunchMethod;
  launchArgs: string;
  workingDir: string | null;
  linkSource: "auto" | "manual" | null;
  linkedAt: number | null;
  lastValidatedAt: number | null;
  validationStatus: ValidationStatus;
  validationMessage: string | null;
  /** True only when the last validation confirmed a usable launch target. */
  installed: boolean;
  source: GameSource;
  externalId: string | null;
  steamAppId: number | null;
  hidden: boolean;
  heroPath: string | null;
  iconPath: string | null;
  artAttempted: boolean;
}

/** Where a game came from. `catalog` = the four built-in games. */
export type GameSource = "catalog" | "steam" | "epic" | "roblox" | "minecraft" | "startmenu" | "library" | "custom" | "pc";

export interface Session {
  id: number;
  gameId: number;
  slug: string;
  startedAt: number;
  endedAt: number | null;
  durationSecs: number;
  launchMethod: LaunchMethod;
  confirmationStatus: "confirmed" | "resumed" | "detected";
  completionStatus: "active" | "completed" | "recovered";
  lastHeartbeat: number;
}

export interface LaunchEntry {
  id: number;
  gameId: number;
  slug: string;
  attemptedAt: number;
  launchMethod: LaunchMethod;
  outcome: "started" | "confirmed" | "unconfirmed" | "failed";
  error: string | null;
  sessionId: number | null;
}

export type RuntimeState = "idle" | "launching" | "running" | "launch_requested";

export interface RuntimeSnapshot {
  slug: string;
  state: RuntimeState;
  pid: number | null;
  sessionId: number | null;
  startedAt: number | null;
  message: string | null;
}

export type ThemeId =
  | "midnight-purple"
  | "dark-blue"
  | "oled-black"
  | "crimson"
  | "emerald"
  | "light"
  | "light-sky"
  | "light-rose"
  | "light-mint"
  | "light-sunset"
  | "light-graphite";
export type SortKey = "name" | "lastPlayed" | "playtime" | "added";
export type StatsRange = "7d" | "30d" | "90d" | "all";

export interface AppSettings {
  libraryRoot: string;
  launchOnStartup: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  autoUpdate: boolean;
  confirmExit: boolean;
  restoreWindow: boolean;
  theme: ThemeId;
  accentColor: string | null;
  backgroundColor: string | null;
  panelColor: string | null;
  cornerRadius: number;
  animationIntensity: "none" | "low" | "normal" | "high";
  reduceMotion: boolean;
  density: "compact" | "comfortable" | "spacious";
  cardSize: number;
  artworkStyle: "poster" | "landscape" | "square";
  sidebarCollapsed: boolean;
  viewMode: "grid" | "list";
  sortBy: SortKey;
  confirmBeforeLaunch: boolean;
  minimizeOnLaunch: boolean;
  trackExternalLaunches: boolean;
  detectOtherGames: boolean;
  fetchArtworkOnline: boolean;
  notificationsEnabled: boolean;
  notifyOnLaunch: boolean;
  notifyOnErrors: boolean;
  notifyOnSessionEnd: boolean;
  statsRange: StatsRange;
}

export interface LibraryStatus {
  root: string;
  available: boolean;
  code: string | null;
  message: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  build: string;
  tauriVersion: string;
  webviewVersion: string | null;
  os: string;
  dataDir: string;
  logDir: string;
  dbPath: string;
}

export interface Recovery {
  preservedAt: string;
  reason: string;
}

export interface Bootstrap {
  games: Game[];
  settings: AppSettings;
  runtime: RuntimeSnapshot[];
  library: LibraryStatus;
  app: AppInfo;
  firstRun: boolean;
  dbRecovery: Recovery | null;
}

export interface Candidate {
  exePath: string;
  installDir: string;
  score: number;
  reasons: string[];
  size: number;
  productName: string | null;
}

export interface ScanItem {
  slug: string;
  title: string;
  outcome: "linked" | "kept" | "ambiguous" | "not_found";
  candidates: Candidate[];
  message: string | null;
}

export interface DetectedItem {
  slug: string;
  title: string;
  source: GameSource;
  outcome: "added" | "linked" | "updated";
}

export interface DeepCandidate {
  id: string;
  title: string;
  root: string;
  exe: string;
  engine: string;
  /** 0–100: how sure the scanner is that this is really a game. */
  confidence: number;
  reasons: string[];
  size: number;
}

export interface DeepProgress {
  dirs: number;
  found: number;
  current: string;
  elapsedSecs: number;
}

export interface DeepStatus {
  running: boolean;
  finished: boolean;
  cancelled: boolean;
  hitLimit: boolean;
  progress: DeepProgress;
  candidates: DeepCandidate[];
}

export interface ScanReport {
  root: string;
  scannedAt: number;
  items: ScanItem[];
  detected: DetectedItem[];
}

export interface LinkResult {
  outcome: "linked" | "ambiguous";
  game: Game | null;
  candidates: Candidate[];
}

export interface LaunchSettingsInput {
  method: LaunchMethod;
  target: string;
  installPath: string | null;
  args: string;
  workingDir: string | null;
}

export type Page = "home" | "library" | "recent" | "favourites" | "stats" | "other" | "settings" | "game";

/** One of the other WIISB apps (WIISB Chat, WIISBROWSING). */
export interface OtherApp {
  id: "chat" | "browser";
  name: string;
  tagline: string;
  installed: boolean;
  path: string | null;
  source: "installed" | "project" | "chosen" | null;
  running: boolean;
  icon: string | null;
  /** The launcher carries this app's setup program, so it can install it. */
  canInstall: boolean;
}

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "error";
  title: string;
  message?: string;
}

/** What "Check for updates" found. */
export interface UpdateCheck {
  status: "upToDate" | "ready" | "busy" | "unavailable" | "error";
  version: string | null;
  message: string;
}
