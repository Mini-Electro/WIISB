import { useState } from "react";
import { CircleAlert, FileCode2, FolderSearch, Minimize2, Play, RefreshCw, Settings as SettingsIcon, Square } from "lucide-react";
import { api, AppError } from "@/services/api";
import { pickExecutable } from "@/services/dialogs";
import { Badge, Button, Modal, TextInput, cx } from "@/components/ui";
import { useApp } from "@/stores/appStore";
import { formatBytes, shortPath } from "@/utils/format";
import { SOURCE_LABEL } from "@/utils/library";
import { DeepScanModal } from "./DeepScanModal";
import { linkPath, locateGame } from "./library";
import { LaunchSettingsForm } from "./LaunchSettingsForm";
import type { Candidate } from "@/types";

function LocateModal({ slug }: { slug: string }) {
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  const close = () => useApp.getState().setModal(null);
  if (!game) return null;
  return (
    <Modal
      open
      onClose={close}
      title={`Locate ${game.title}`}
      description="Point WIISB Launcher at the game you already have installed. Nothing in the installation is changed — the launcher only remembers where it is."
      footer={<Button variant="ghost" onClick={close}>Cancel</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={() => void locateGame(slug, "folder")} className="panel-elevated flex flex-col items-start gap-2 p-4 text-left t-transition hover:border-accent/60">
          <FolderSearch className="text-accent2" />
          <span className="font-semibold">Choose installation folder</span>
          <span className="text-xs text-muted">We'll look inside it for the game's launch file.</span>
        </button>
        <button onClick={() => void locateGame(slug, "exe")} className="panel-elevated flex flex-col items-start gap-2 p-4 text-left t-transition hover:border-accent/60">
          <FileCode2 className="text-accent2" />
          <span className="font-semibold">Choose the .exe directly</span>
          <span className="text-xs text-muted">Best when the folder has several programs.</span>
        </button>
      </div>
      {game.validationMessage && game.validationStatus !== "not_linked" && <p className="mt-4 text-[13px] text-warning">{game.validationMessage}</p>}
    </Modal>
  );
}

function CandidateModal({ slug, candidates }: { slug: string; candidates: Candidate[] }) {
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const close = () => useApp.getState().setModal(null);
  if (!game) return null;
  return (
    <Modal
      open
      onClose={close}
      width={640}
      title={`Which one launches ${game.title}?`}
      description="More than one plausible program was found. Pick the one that starts the game — nothing is run to find out."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const c = candidates[pick];
              await linkPath(slug, c.exePath, c.installDir);
              setBusy(false);
            }}
          >
            Use this one
          </Button>
        </>
      }
    >
      <div role="radiogroup" className="space-y-2">
        {candidates.map((c, i) => (
          <button
            key={c.exePath}
            role="radio"
            aria-checked={pick === i}
            onClick={() => setPick(i)}
            className={cx("w-full rounded-ctl border p-3 text-left t-transition", pick === i ? "border-accent bg-accent/10" : "border-line bg-elevated hover:border-line-strong")}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-[12.5px] font-semibold" title={c.exePath}>{shortPath(c.exePath, 4)}</span>
              <Badge tone={i === 0 ? "accent" : "neutral"}>{i === 0 ? "Best match" : `Score ${c.score}`}</Badge>
            </div>
            <div className="mt-1 text-xs text-muted">
              {formatBytes(c.size)}
              {c.productName ? ` · ${c.productName}` : ""} · {c.reasons.join(" · ")}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function ScanModal({ report }: { report: import("@/types").ScanReport }) {
  const games = useApp((s) => s.games);
  const setModal = useApp((s) => s.setModal);
  const chooseRoot = useApp((s) => s.chooseLibraryRoot);
  const close = () => setModal(null);
  const installed = games.filter((g) => g.installed).length;
  return (
    <Modal
      open
      onClose={close}
      width={620}
      title="Library discovery"
      description={
        <>
          Searched <span className="font-mono text-[12px]">{report.root}</span> and your game launchers (read-only). {installed} of {games.length} games are ready to play.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => void chooseRoot()}>Change library folder…</Button>
          <Button variant="primary" onClick={close}>Done</Button>
        </>
      }
    >
      {report.detected.length > 0 && (
        <div className="mb-4 rounded-ctl border border-accent/30 bg-accent/10 p-3">
          <div className="text-sm font-semibold">
            {report.detected.length} more game{report.detected.length === 1 ? "" : "s"} found
          </div>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {report.detected.map((d) => (
              <li key={d.slug}>
                <Badge tone="accent">
                  {d.title} · {SOURCE_LABEL[d.source]}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Covers are fetched from Steam in the background. Remove anything that isn't a game from its page.</p>
        </div>
      )}
      <ul className="divide-y divide-line">
        {report.items.map((item) => {
          const game = games.find((g) => g.slug === item.slug);
          const ok = !!game?.installed;
          return (
            <li key={item.slug} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="display text-[15px] font-semibold">
                  {item.title} <span className="text-muted">—</span>{" "}
                  <span className={ok ? "text-success" : item.outcome === "ambiguous" ? "text-warning" : "text-muted"}>
                    {ok ? "Installed" : item.outcome === "ambiguous" ? "Needs confirmation" : "Not Found"}
                  </span>
                </div>
                <div className="truncate font-mono text-[11.5px] text-muted" title={game?.launchTarget ?? undefined}>
                  {ok ? shortPath(game!.launchTarget ?? "", 4) : (item.message ?? "")}
                </div>
              </div>
              {item.outcome === "ambiguous" && <Button size="sm" variant="primary" onClick={() => setModal({ type: "candidates", slug: item.slug, candidates: item.candidates })}>Choose…</Button>}
              {!ok && item.outcome !== "ambiguous" && <Button size="sm" variant="secondary" onClick={() => setModal({ type: "locate", slug: item.slug })}>Locate Installation</Button>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function AddGameModal() {
  const [title, setTitle] = useState("");
  const [exe, setExe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = useApp.getState();
  const close = () => st.setModal(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const g = await api.addCustomGame(title, exe);
      await st.refreshGames();
      st.toast("success", `${g.title} added`);
      st.setModal(null);
      st.openGame(g.slug);
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={close}
      title="Add a game"
      description="For anything WIISB Launcher didn't find on its own. Pick the program that starts it — it's never run until you press Play."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!title.trim() || !exe.trim()} onClick={() => void submit()}>Add game</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">Name</div>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Game title" aria-label="Game title" maxLength={80} autoFocus />
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">Program (.exe)</div>
          <div className="flex gap-2">
            <TextInput value={exe} onChange={(e) => setExe(e.target.value)} placeholder="D:\Games\MyGame\MyGame.exe" aria-label="Executable path" className="font-mono !text-[12.5px]" />
            <Button
              variant="secondary"
              onClick={async () => {
                const p = await pickExecutable("Select the game's executable");
                if (p) {
                  setExe(p);
                  if (!title.trim()) setTitle(p.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "");
                }
              }}
            >
              Browse
            </Button>
          </div>
        </div>
        {error && <div role="alert" className="rounded-ctl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

function ConfirmLaunchModal({ slug }: { slug: string }) {
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  const { setModal, launch } = useApp.getState();
  if (!game) return null;
  return (
    <Modal
      open
      onClose={() => setModal(null)}
      width={440}
      title={`Launch ${game.title}?`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" icon={<Play size={16} fill="currentColor" />} onClick={() => (setModal(null), void launch(slug))}>Launch</Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">You can turn this confirmation off in Settings → Game Launching.</p>
    </Modal>
  );
}

function ConfirmStopModal({ slug }: { slug: string }) {
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  const [busy, setBusy] = useState(false);
  const { setModal, stopGame } = useApp.getState();
  if (!game) return null;
  return (
    <Modal
      open
      onClose={() => setModal(null)}
      width={460}
      title={`Force stop ${game.title}?`}
      description="This ends the game immediately, like closing it from Task Manager. Anything you haven't saved in the game will be lost."
      footer={
        <>
          <Button variant="ghost" onClick={() => setModal(null)}>Keep playing</Button>
          <Button
            variant="danger"
            loading={busy}
            icon={<Square size={14} fill="currentColor" />}
            onClick={async () => {
              setBusy(true);
              await stopGame(slug);
              setBusy(false);
              setModal(null);
            }}
          >
            Force stop
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">Only {game.title}'s own programs are ended. Time played so far is kept.</p>
    </Modal>
  );
}

function ConfirmExitModal() {
  const { setModal } = useApp.getState();
  const closeToTray = useApp((s) => s.settings?.closeToTray);
  return (
    <Modal
      open
      onClose={() => setModal(null)}
      width={460}
      title="Exit WIISB Launcher?"
      description="Any game you're playing keeps running — only the launcher closes, and playtime tracking resumes next time you open it."
      footer={
        <>
          <Button variant="ghost" onClick={() => setModal(null)}>Stay</Button>
          <Button variant="secondary" icon={<Minimize2 size={16} />} onClick={() => (setModal(null), void api.hideToTray())}>Hide to tray</Button>
          <Button variant="danger" onClick={() => void api.quit()}>Exit</Button>
        </>
      }
    >
      {closeToTray && <p className="text-[13px] text-muted">Close-to-tray is on, so the close button hides the window instead.</p>}
    </Modal>
  );
}

function LaunchSettingsModal({ slug }: { slug: string }) {
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  if (!game) return null;
  return (
    <Modal open onClose={() => useApp.getState().setModal(null)} width={640} title={`${game.title} — launch settings`} description="Change where the game is installed and how it's started.">
      <LaunchSettingsForm game={game} onSaved={() => useApp.getState().setModal(null)} />
    </Modal>
  );
}

function LaunchErrorModal({ slug, code, message }: { slug: string; code: string; message: string }) {
  const st = useApp.getState();
  const game = useApp((s) => s.games.find((g) => g.slug === slug));
  const [busy, setBusy] = useState(false);
  if (!game) return null;
  const close = () => st.setModal(null);
  const drive = code === "drive_unavailable";
  const missing = code === "not_found" || code === "invalid";
  const title = drive ? "Your game library drive could not be accessed." : missing ? "We couldn't find the executable for this game." : "WIISB Launcher couldn't start this game.";
  return (
    <Modal
      open
      onClose={close}
      width={540}
      title={title}
      description={game.title}
      footer={
        drive ? (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="secondary" icon={<SettingsIcon size={16} />} onClick={() => (close(), st.navigate("settings"))}>Open settings</Button>
            <Button variant="secondary" onClick={() => (close(), void st.chooseLibraryRoot())}>Change library folder</Button>
            <Button variant="primary" icon={<RefreshCw size={16} />} loading={busy} onClick={async () => { setBusy(true); await st.retryLibrary(); setBusy(false); close(); }}>Retry</Button>
          </>
        ) : missing ? (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={() => (close(), void st.scan(false))}>Rescan</Button>
            <Button variant="primary" icon={<FolderSearch size={16} />} onClick={() => st.setModal({ type: "locate", slug })}>Locate game</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Close</Button>
            <Button variant="secondary" onClick={() => st.setModal({ type: "launchSettings", slug })}>Edit launch settings</Button>
            <Button variant="primary" onClick={() => (close(), void st.launch(slug))}>Try again</Button>
          </>
        )
      }
    >
      <div className="flex gap-3 rounded-ctl border border-line bg-bg/50 p-3 text-[13px] leading-relaxed">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" />
        <div>
          {message}
          {game.launchTarget && <div className="mt-2 break-all font-mono text-[11.5px] text-muted">{game.launchTarget}</div>}
        </div>
      </div>
    </Modal>
  );
}

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  if (!modal) return null;
  switch (modal.type) {
    case "locate":
      return <LocateModal slug={modal.slug} />;
    case "candidates":
      return <CandidateModal slug={modal.slug} candidates={modal.candidates} />;
    case "scan":
      return <ScanModal report={modal.report} />;
    case "addGame":
      return <AddGameModal />;
    case "deepScan":
      return <DeepScanModal />;
    case "confirmLaunch":
      return <ConfirmLaunchModal slug={modal.slug} />;
    case "confirmStop":
      return <ConfirmStopModal slug={modal.slug} />;
    case "confirmExit":
      return <ConfirmExitModal />;
    case "launchSettings":
      return <LaunchSettingsModal slug={modal.slug} />;
    case "launchError":
      return <LaunchErrorModal slug={modal.slug} code={modal.code} message={modal.message} />;
  }
}
