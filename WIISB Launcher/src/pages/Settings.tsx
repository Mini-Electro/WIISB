import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  CloudDownload,
  EyeOff,
  HardDrive,
  Download,
  FolderOpen,
  Gamepad2,
  Info,
  LibraryBig,
  Palette,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Wrench,
  ChartColumn,
} from "lucide-react";
import { api, AppError } from "@/services/api";
import { pickCsvDestination } from "@/services/dialogs";
import { useApp } from "@/stores/appStore";
import { useNow } from "@/hooks/hooks";
import { ACCENT_PRESETS, THEME_OPTIONS } from "@/utils/theme";
import { effectiveDuration } from "@/utils/stats";
import { formatDateTime, formatDuration } from "@/utils/format";
import { Badge, Button, Segmented, Select, SettingRow, TextInput, Toggle, cx } from "@/components/ui";
import { StatusBadge } from "@/components/game";
import { LaunchSettingsForm } from "@/features/LaunchSettingsForm";
import { chooseArtwork, resetArtwork, reveal, unlink } from "@/features/library";
import { SOURCE_LABEL } from "@/utils/library";
import type { AppSettings, Game } from "@/types";

type Tab = "general" | "appearance" | "library" | "launching" | "statistics" | "notifications" | "advanced" | "about";
const TABS: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "library", label: "Library", icon: LibraryBig },
  { id: "launching", label: "Game Launching", icon: Gamepad2 },
  { id: "statistics", label: "Statistics", icon: ChartColumn },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "advanced", label: "Advanced", icon: Wrench },
  { id: "about", label: "About", icon: Info },
];

function Section({ title, children, intro }: { title: string; children: ReactNode; intro?: ReactNode }) {
  return (
    <section className="panel mb-[var(--gap)] p-5 pb-2">
      <h2 className="display text-lg font-semibold">{title}</h2>
      {intro && <p className="mt-1 text-[13px] text-muted">{intro}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function ToggleRow({ k, title, description, disabled }: { k: keyof AppSettings; title: string; description?: ReactNode; disabled?: boolean }) {
  const value = useApp((s) => s.settings?.[k]) as boolean;
  const patch = useApp((s) => s.patchSettings);
  return (
    <SettingRow title={title} description={description}>
      <Toggle label={title} checked={value} disabled={disabled} onChange={(v) => void patch({ [k]: v } as Partial<AppSettings>)} />
    </SettingRow>
  );
}

function ColorField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={label} value={value ?? fallback} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-12 rounded-ctl border border-line bg-elevated" />
      <span className="w-[74px] font-mono text-xs text-muted">{value ?? "theme"}</span>
      <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} disabled={!value} onClick={() => onChange(null)}>
        Reset
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- General */
function UpdateCheckRow() {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const check = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api.checkForUpdates();
      setNote(r.message);
      toast(r.status === "error" || r.status === "unavailable" ? "error" : r.status === "ready" ? "success" : "info", r.message);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow title="Check for updates" description={note || "Look for a newer version of WIISB Launcher right now."}>
      <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={busy} onClick={() => void check()}>
        {busy ? "Checking…" : "Check for updates"}
      </Button>
    </SettingRow>
  );
}

function General() {
  return (
    <Section title="General">
      <ToggleRow k="launchOnStartup" title="Launch on Windows startup" description="Adds WIISB Launcher to your Windows startup apps. Turning it off removes the entry again." />
      <ToggleRow k="startMinimized" title="Start minimised" description="Open quietly — in the tray if tray options are on, otherwise minimised to the taskbar." />
      <ToggleRow k="minimizeToTray" title="Minimise to tray" description="The minimise button hides WIISB Launcher in the system tray." />
      <ToggleRow k="closeToTray" title="Close to tray" description="The close button hides the window instead of exiting. Use the tray menu's Exit to quit." />
      <ToggleRow k="autoUpdate" title="Automatic updates" description="Quietly download new versions of WIISB Launcher in the background. Nothing restarts until you choose “Restart to update”." />
      <UpdateCheckRow />
      <ToggleRow k="confirmExit" title="Confirm before exiting" description="Ask first when you close the window. Games you're playing are never closed." />
      <ToggleRow k="restoreWindow" title="Restore previous window position" description="Remember the window's size, position and maximised state." />
      <SettingRow title="Keyboard shortcuts" description="Ctrl+K search · Ctrl+B sidebar · Ctrl+1…6 pages · Ctrl+, settings · Alt+← back" />
    </Section>
  );
}

/* ------------------------------------------------------------- Appearance */
function Appearance() {
  const s = useApp((st) => st.settings)!;
  const patch = useApp((st) => st.patchSettings);
  const swatch = THEME_OPTIONS.find((t) => t.id === s.theme)!.swatch;
  return (
    <>
      <Section title="Theme">
        <div className="grid grid-cols-2 gap-3 pb-4 pt-1 sm:grid-cols-3">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              onClick={() => void patch({ theme: t.id, accentColor: null, backgroundColor: null, panelColor: null })}
              aria-pressed={s.theme === t.id}
              className={cx("rounded-card border p-3 text-left t-transition grow-sm", s.theme === t.id ? "border-accent bg-accent/10" : "border-line hover:border-line-strong")}
            >
              <div className="flex h-12 overflow-hidden rounded-ctl border border-line-strong">
                <div className="flex-1" style={{ background: t.swatch[0] }} />
                <div className="flex-1" style={{ background: t.swatch[1] }} />
                <div className="flex-1" style={{ background: t.swatch[2] }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-[13px] font-semibold">
                {t.name}
                {s.theme === t.id && <Check size={14} className="text-accent2" />}
              </div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Colours" intro="Override the theme's colours. “Reset” returns to the theme default.">
        <SettingRow title="Accent colour">
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="flex gap-1.5">
              {ACCENT_PRESETS.map((c) => (
                <button key={c} aria-label={`Accent ${c}`} onClick={() => void patch({ accentColor: c })} className={cx("h-7 w-7 rounded-full border-2 t-transition", s.accentColor === c ? "border-fg" : "border-transparent hover:scale-110")} style={{ background: c }} />
              ))}
            </div>
            <ColorField label="Accent colour" value={s.accentColor} fallback={swatch[2]} onChange={(v) => void patch({ accentColor: v })} />
          </div>
        </SettingRow>
        <SettingRow title="Background colour">
          <ColorField label="Background colour" value={s.backgroundColor} fallback={swatch[0]} onChange={(v) => void patch({ backgroundColor: v })} />
        </SettingRow>
        <SettingRow title="Panel colour">
          <ColorField label="Panel colour" value={s.panelColor} fallback={swatch[1]} onChange={(v) => void patch({ panelColor: v })} />
        </SettingRow>
      </Section>
      <Section title="Layout & motion">
        <SettingRow title="Corner radius" description={`${s.cornerRadius}px`}>
          <input type="range" aria-label="Corner radius" min={4} max={32} value={s.cornerRadius} onChange={(e) => void patch({ cornerRadius: +e.target.value })} className="w-44" />
        </SettingRow>
        <SettingRow title="Layout density" description="Spacing between and inside panels.">
          <Segmented label="Density" value={s.density} onChange={(v) => void patch({ density: v })} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "spacious", label: "Spacious" }]} />
        </SettingRow>
        <SettingRow title="Grid card size" description={`${s.cardSize}px minimum width`}>
          <input type="range" aria-label="Card size" min={160} max={320} step={10} value={s.cardSize} onChange={(e) => void patch({ cardSize: +e.target.value })} className="w-44" />
        </SettingRow>
        <SettingRow title="Artwork display style" description="Shape of game artwork in the library.">
          <Segmented label="Artwork style" value={s.artworkStyle} onChange={(v) => void patch({ artworkStyle: v })} options={[{ value: "poster", label: "Poster" }, { value: "landscape", label: "Landscape" }, { value: "square", label: "Square" }]} />
        </SettingRow>
        <SettingRow title="Animation intensity" description="How much hover and transition motion is used.">
          <Select label="Animation intensity" value={s.animationIntensity} onChange={(v) => void patch({ animationIntensity: v })} options={[{ value: "none", label: "None" }, { value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }]} />
        </SettingRow>
        <ToggleRow k="reduceMotion" title="Reduce motion" description="Turns animations off. Also follows the Windows “Show animations” setting automatically." />
      </Section>
    </>
  );
}

/* ------------------------------------------------------- Detection & covers */
function Detection() {
  const refresh = useApp((st) => st.refreshGames);
  const toast = useApp((st) => st.toast);
  const games = useApp((st) => st.games);
  const [hidden, setHidden] = useState<Game[]>([]);
  const [busy, setBusy] = useState<"detect" | "covers" | null>(null);
  const openDeepScan = useApp((st) => st.openDeepScan);
  useEffect(() => {
    api.hiddenGames().then(setHidden).catch(() => {});
  }, [games.length]);
  const sourceCount = (src: string) => games.filter((g) => g.source === src).length;
  return (
    <Section title="Game detection & covers" intro="Beyond the folder above, WIISB Launcher can find games from your launchers. Detection only reads the manifests and shortcuts they already keep — nothing is run, and no files are changed.">
      <ToggleRow k="detectOtherGames" title="Detect other games" description={`Steam (all library folders), Epic Games, Roblox, Minecraft and OneClient, Start Menu games and extra game folders in your library folder. Currently: ${sourceCount("steam")} Steam · ${sourceCount("epic")} Epic · ${sourceCount("library")} from folders · ${sourceCount("roblox") + sourceCount("minecraft") + sourceCount("startmenu") + sourceCount("custom")} other.`} />
      <ToggleRow k="fetchArtworkOnline" title="Fetch covers from Steam" description="Looks up each game's cover and banner on Steam's public store and saves them here. Only the game's title is sent. Falls back to the program's own icon." />
      <SettingRow title="Scan the whole PC" description="Searches every local drive for installed games, then lets you pick which to add. Read-only, low priority, and it can be stopped at any time.">
        <Button variant="primary" icon={<HardDrive size={16} />} onClick={() => void openDeepScan()}>
          Scan whole PC…
        </Button>
      </SettingRow>
      <SettingRow title="Run now" description="Detect new games from your launchers and fill in missing covers.">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} />}
            loading={busy === "detect"}
            onClick={async () => {
              setBusy("detect");
              try {
                const items = await api.detectGames();
                await refresh();
                toast(items.length ? "success" : "info", items.length ? `${items.length} game${items.length === 1 ? "" : "s"} found or updated` : "No new games found");
              } catch (e) {
                toast("error", "Detection failed", (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            Detect games
          </Button>
          <Button
            variant="secondary"
            icon={<CloudDownload size={16} />}
            loading={busy === "covers"}
            onClick={async () => {
              setBusy("covers");
              try {
                await api.fetchArtwork();
                toast("info", "Looking for covers…", "They appear as they download.");
              } catch (e) {
                toast("error", "Couldn't fetch covers", (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            Fetch missing covers
          </Button>
        </div>
      </SettingRow>
      <SettingRow title="Removed games" description={hidden.length ? "Hidden from your library. Restore any time." : "Games you remove from the library appear here."} stack={hidden.length > 0}>
        {hidden.length > 0 && (
          <ul className="divide-y divide-line rounded-ctl border border-line">
            {hidden.map((g) => (
              <li key={g.slug} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <EyeOff size={14} className="text-muted" />
                  <span className="truncate">{g.title}</span>
                  <span className="text-xs font-normal text-muted">{SOURCE_LABEL[g.source]}</span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await api.setGameHidden(g.slug, false).catch((e) => toast("error", "Couldn't restore", (e as Error).message));
                    await refresh();
                    setHidden(await api.hiddenGames().catch(() => []));
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingRow>
    </Section>
  );
}

/* ---------------------------------------------------------------- Library */
function LibrarySettings() {
  const s = useApp((st) => st.settings)!;
  const library = useApp((st) => st.library);
  const games = useApp((st) => st.games);
  const scan = useApp((st) => st.scan);
  const scanning = useApp((st) => st.scanning);
  const choose = useApp((st) => st.chooseLibraryRoot);
  const refresh = useApp((st) => st.refreshGames);
  const setModal = useApp((st) => st.setModal);
  const [confirmForce, setConfirmForce] = useState(false);
  return (
    <>
      <Section title="Library folder" intro="WIISB Launcher searches this folder (read-only) for your games. You can point it anywhere — nothing inside is ever modified.">
        <div className="space-y-3 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <TextInput readOnly value={s.libraryRoot} aria-label="Library folder" className="flex-1 font-mono !text-[12.5px]" />
            {library?.available ? <Badge tone="success">Online</Badge> : <Badge tone="danger">Unavailable</Badge>}
          </div>
          {library && !library.available && <div className="text-[13px] text-danger">{library.message}</div>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<FolderOpen size={16} />} onClick={() => void choose()}>Change folder…</Button>
            <Button variant="secondary" loading={scanning} icon={<RefreshCw size={16} />} onClick={() => void scan(false)}>Rescan</Button>
            <Button variant="secondary" onClick={() => void refresh()}>Validate all installations</Button>
            <Button variant="ghost" onClick={() => void reveal("library_root")}>Open folder</Button>
          </div>
          <div className="rounded-ctl border border-line bg-elevated/50 p-3 text-[13px]">
            <div className="font-semibold">Re-detect everything</div>
            <p className="mt-0.5 text-muted">Rescan normally keeps links you set by hand. Re-detect discards every link and finds the games again from scratch.</p>
            {confirmForce ? (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="danger" onClick={() => (setConfirmForce(false), void scan(true))}>Yes, re-detect all</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmForce(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" className="mt-2" variant="secondary" onClick={() => setConfirmForce(true)}>Re-detect all…</Button>
            )}
          </div>
        </div>
      </Section>

      <Detection />

      <Section title="Game installations" intro="Each game can live anywhere — it doesn't have to be inside the library folder.">
        <ul className="divide-y divide-line">
          {games.map((g) => (
            <li key={g.slug} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="display text-base font-semibold">{g.title}</span>
                  <StatusBadge game={g} />
                  {g.linkSource === "manual" && <Badge>Manual link</Badge>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setModal({ type: "locate", slug: g.slug })}>{g.installed ? "Change installation…" : "Locate installation…"}</Button>
                  <Button size="sm" variant="ghost" disabled={!g.installationPath && !g.launchTarget} onClick={() => void reveal("installation", g.slug)}>Open folder</Button>
                  <Button size="sm" variant="ghost" disabled={!g.launchTarget} onClick={() => void unlink(g.slug)}>Unlink</Button>
                </div>
              </div>
              <div className="mt-1.5 break-all font-mono text-[11.5px] text-muted">{g.launchTarget ?? "Not linked"}</div>
              {g.validationMessage && !g.installed && <div className="mt-1 text-xs text-warning">{g.validationMessage}</div>}
              <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                Artwork: {g.artworkPath ? "custom image" : "generated placeholder"}
                <Button size="sm" variant="ghost" onClick={() => void chooseArtwork(g.slug)}>Change…</Button>
                {g.artworkPath && <Button size="sm" variant="ghost" onClick={() => void resetArtwork(g.slug)}>Reset</Button>}
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/* --------------------------------------------------------------- Launching */
function Launching() {
  const games = useApp((st) => st.games);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Section title="Launching">
        <ToggleRow k="confirmBeforeLaunch" title="Confirm before launching" description="Show a quick “Launch this game?” prompt before PLAY starts anything." />
        <ToggleRow k="minimizeOnLaunch" title="Minimise WIISB Launcher when a game starts" />
        <ToggleRow k="trackExternalLaunches" title="Track games started outside WIISB Launcher" description="If a linked game is already running (for example you opened it from Explorer), playtime is recorded from the moment it's noticed." />
      </Section>
      <Section title="Per-game launch settings" intro="Choose how each game starts, change its executable or installation folder, and set arguments. Arguments are passed as separate parameters — there is no shell and no free-form command field.">
        <ul className="divide-y divide-line">
          {games.map((g) => (
            <li key={g.slug} className="py-3">
              <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === g.slug ? null : g.slug)} aria-expanded={open === g.slug}>
                <span className="flex items-center gap-2">
                  <span className="display font-semibold">{g.title}</span>
                  <span className="text-xs text-muted">{g.launchTarget ? g.launchMethod : "not linked"}</span>
                </span>
                <ChevronDown size={18} className={cx("text-muted t-transition", open === g.slug && "rotate-180")} />
              </button>
              {open === g.slug && (
                <div className="pb-3 pt-4">
                  <LaunchSettingsForm game={g} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/* -------------------------------------------------------------- Statistics */
function StatisticsSettings() {
  const sessions = useApp((st) => st.sessions);
  const games = useApp((st) => st.games);
  const toast = useApp((st) => st.toast);
  const refreshSessions = useApp((st) => st.refreshSessions);
  const range = useApp((st) => st.settings!.statsRange);
  const patch = useApp((st) => st.patchSettings);
  const now = useNow(false);
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const latest = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);

  const exportCsv = async () => {
    try {
      const dest = await pickCsvDestination();
      if (!dest) return;
      const n = await api.exportCsv(dest);
      toast("success", `Exported ${n} session${n === 1 ? "" : "s"}`, dest);
    } catch (e) {
      toast("error", "Export failed", (e as AppError).message);
    }
  };
  const reset = async () => {
    try {
      await api.resetStats(confirm);
      await refreshSessions();
      setConfirm("");
      setResetting(false);
      toast("success", "Statistics reset");
    } catch (e) {
      toast("error", "Couldn't reset statistics", (e as AppError).message);
    }
  };

  return (
    <>
      <Section title="Statistics">
        <SettingRow title="Default time range" description="Used when you open the Statistics page.">
          <Select label="Default range" value={range} onChange={(v) => void patch({ statsRange: v })} options={[{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "90d", label: "Last 90 days" }, { value: "all", label: "All time" }]} />
        </SettingRow>
        <SettingRow title="Export session history" description="Save every recorded session as a CSV file (times in UTC).">
          <Button variant="secondary" icon={<Download size={16} />} disabled={sessions.length === 0} onClick={() => void exportCsv()}>Export CSV…</Button>
        </SettingRow>
        <SettingRow title="Reset statistics" description="Permanently deletes all finished sessions and the launch log. A game that's running right now is kept.">
          {resetting ? (
            <div className="flex items-center gap-2">
              <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type RESET" aria-label="Type RESET to confirm" className="!w-36" />
              <Button variant="danger" disabled={confirm !== "RESET"} onClick={() => void reset()}>Delete</Button>
              <Button variant="ghost" onClick={() => (setResetting(false), setConfirm(""))}>Cancel</Button>
            </div>
          ) : (
            <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setResetting(true)}>Reset…</Button>
          )}
        </SettingRow>
      </Section>

      <Section title="How tracking works" intro={undefined}>
        <ul className="list-disc space-y-1.5 pb-4 pl-5 text-[13px] leading-relaxed text-muted">
          <li>Time is recorded only while WIISB Launcher can <em>see</em> the game's process running. Launcher or loading screens before that aren't counted.</li>
          <li>If the game starts through another launcher or platform, the session starts when the real game process appears.</li>
          <li>Closing WIISB Launcher doesn't stop your game. When you reopen it, the same running process is picked up again and no time is counted twice.</li>
          <li>If Windows shuts down or WIISB Launcher crashes, the session ends at the last moment it was confirmed running — nothing is guessed.</li>
          <li>Some anti-cheat or elevated games hide their process from other programs; for those, a launch can only be shown as “requested”.</li>
        </ul>
      </Section>

      <Section title="Session history">
        {latest.length === 0 ? (
          <p className="pb-4 text-[13px] text-muted">No sessions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto pb-3">
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead className="text-xs uppercase tracking-wider text-muted">
                <tr><th className="pb-2 font-semibold">Game</th><th className="pb-2 font-semibold">Started</th><th className="pb-2 font-semibold">Duration</th><th className="pb-2 font-semibold">Result</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {latest.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 font-semibold">{games.find((g) => g.slug === s.slug)?.title ?? s.slug}</td>
                    <td>{formatDateTime(s.startedAt)}</td>
                    <td className="tabular-nums">{formatDuration(effectiveDuration(s, now))}</td>
                    <td className="text-muted">{s.completionStatus}{s.confirmationStatus !== "confirmed" ? ` · ${s.confirmationStatus}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Notifications() {
  const on = useApp((st) => st.settings!.notificationsEnabled);
  return (
    <Section title="Notifications" intro="Native Windows notifications. They are kept deliberately sparse.">
      <ToggleRow k="notificationsEnabled" title="Enable notifications" />
      <ToggleRow k="notifyOnLaunch" title="Game launched" description="“DELTARUNE launched.” — sent when the running game is confirmed." disabled={!on} />
      <ToggleRow k="notifyOnErrors" title="Launch problems" description="When a game can't be started, with a hint about what to check." disabled={!on} />
      <ToggleRow k="notifyOnSessionEnd" title="Session completed" description="Only for sessions of a minute or longer." disabled={!on} />
    </Section>
  );
}

function Advanced() {
  const info = useApp((st) => st.appInfo);
  const patch = useApp((st) => st.patchSettings);
  const toast = useApp((st) => st.toast);
  return (
    <Section title="Advanced">
      <SettingRow title="Application data" description={<span className="break-all font-mono text-[11.5px]">{info?.dataDir}</span>}>
        <Button variant="secondary" icon={<FolderOpen size={16} />} onClick={() => void reveal("data")}>Open</Button>
      </SettingRow>
      <SettingRow title="Technical log" description={<span className="break-all font-mono text-[11.5px]">{info?.logDir}</span>}>
        <Button variant="secondary" icon={<FolderOpen size={16} />} onClick={() => void reveal("logs")}>Open</Button>
      </SettingRow>
      <SettingRow title="Database" description={<span className="break-all font-mono text-[11.5px]">{info?.dbPath}</span>} />
      <SettingRow title="Reset appearance" description="Restore the default theme, colours, spacing and motion. Your library, sessions and notes are untouched.">
        <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={() => void patch({ theme: "midnight-purple", accentColor: null, backgroundColor: null, panelColor: null, cornerRadius: 14, animationIntensity: "normal", reduceMotion: false, density: "comfortable", cardSize: 220, artworkStyle: "poster" }).then(() => toast("success", "Appearance reset"))}>Reset</Button>
      </SettingRow>
    </Section>
  );
}

function About() {
  const info = useApp((st) => st.appInfo);
  return (
    <Section title="About">
      <SettingRow title="Application"><span className="display font-semibold">WIISB Launcher</span></SettingRow>
      <SettingRow title="Version"><span className="font-mono text-[13px]">{info?.version}</span></SettingRow>
      <SettingRow title="Build"><span className="font-mono text-[13px]">{info?.build} · {info?.os}</span></SettingRow>
      <SettingRow title="Technology" description="Tauri 2 · Rust · React · TypeScript · Tailwind CSS · SQLite · WebView2">
        <span className="font-mono text-[12px] text-muted">Tauri {info?.tauriVersion} · WebView2 {info?.webviewVersion ?? "—"}</span>
      </SettingRow>
      <SettingRow title="Application data location" description={<span className="break-all font-mono text-[11.5px]">{info?.dataDir}</span>} />
      <SettingRow title="Your games" description="WIISB Launcher only launches games that are already installed. It never modifies, moves or deletes their files, and never touches licensing or DRM. Cover art comes from Steam's public store and is saved on this PC." />
    </Section>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div className="page-pad flex gap-6">
      <nav aria-label="Settings categories" className="sticky top-0 hidden h-fit w-52 shrink-0 space-y-1 md:block">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className={cx("flex h-10 w-full items-center gap-3 rounded-ctl px-3 text-sm font-semibold t-transition", tab === id ? "bg-accent/15 text-fg" : "text-muted wash hover:text-fg")}>
            <Icon size={17} className={tab === id ? "text-accent2" : undefined} />
            {label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <div className="mb-4 md:hidden">
          <Select label="Settings category" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.id, label: t.label }))} className="w-full" />
        </div>
        <div className="eyebrow mb-1">Preferences</div>
        <h1 className="display mb-5 text-[28px] font-bold leading-none">Settings</h1>
        {tab === "general" && <General />}
        {tab === "appearance" && <Appearance />}
        {tab === "library" && <LibrarySettings />}
        {tab === "launching" && <Launching />}
        {tab === "statistics" && <StatisticsSettings />}
        {tab === "notifications" && <Notifications />}
        {tab === "advanced" && <Advanced />}
        {tab === "about" && <About />}
      </div>
    </div>
  );
}
