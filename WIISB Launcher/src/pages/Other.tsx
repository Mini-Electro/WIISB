import { useCallback, useEffect, useState } from "react";
import { Boxes, Download, Folder, FolderSearch, Globe, MessageCircle, Play, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { pickExecutable } from "@/services/dialogs";
import { useApp } from "@/stores/appStore";
import { Badge, Button } from "@/components/ui";
import { PageHeader } from "@/components/common";
import type { OtherApp, OtherUpdate } from "@/types";

const FALLBACK_ICON = { chat: MessageCircle, browser: Globe } as const;
const EXE_NAME = { chat: "WIISB Chat.exe", browser: "WIISBROWSING.exe" } as const;
const SOURCE_TEXT = { installed: "Installed", project: "From the project folder", chosen: "Chosen by you" } as const;

function AppCard({ app, update, onChanged }: { app: OtherApp; update?: OtherUpdate; onChanged: () => void }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);
  const Icon = FALLBACK_ICON[app.id];

  const install = async () => {
    setInstalling(true);
    try {
      await api.installOtherApp(app.id);
      toast("success", `${app.name} is installed`, "You can launch it from here now.");
      onChanged();
    } catch (e) {
      toast("error", `${app.name} wasn't installed`, (e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const runUpdate = async () => {
    setUpdating(true);
    try {
      const done = await api.updateOtherApp(app.id);
      toast("success", `${app.name} is up to date`, done.installedVersion ? `Now on version ${done.installedVersion}.` : undefined);
    } catch (e) {
      toast("error", `${app.name} wasn't updated`, (e as Error).message);
    } finally {
      setUpdating(false);
      onChanged();
    }
  };

  const launch = async () => {
    setBusy(true);
    try {
      await api.launchOtherApp(app.id);
      toast("info", `Starting ${app.name}`);
      window.setTimeout(onChanged, 2500); // pick up the "Running" state once it's up
    } catch (e) {
      toast("error", `${app.name} didn't start`, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    const start = (await api.otherAppStartDir(app.id).catch(() => null)) ?? undefined;
    const path = await pickExecutable(`Find ${EXE_NAME[app.id]}`, start);
    if (!path) return;
    try {
      await api.locateOtherApp(app.id, path);
      onChanged();
    } catch (e) {
      toast("error", "That isn't the right file", (e as Error).message);
    }
  };

  const openFolder = async () => {
    try {
      await api.revealOtherApp(app.id);
    } catch (e) {
      toast("error", "Couldn't open the folder", (e as Error).message);
    }
  };

  return (
    <article className="panel flex flex-col gap-4 p-5" aria-label={app.name}>
      <div className="flex items-start gap-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-elevated ring-1 ring-line">
          {app.icon ? <img src={app.icon} alt="" width={48} height={48} draggable={false} /> : <Icon size={30} className="text-accent2" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="display text-xl font-bold">{app.name}</h2>
            {installing ? (
              <Badge tone="accent">Installing…</Badge>
            ) : updating ? (
              <Badge tone="accent">Updating…</Badge>
            ) : app.running ? (
              <Badge tone="success">Running</Badge>
            ) : app.installed ? (
              <Badge tone="accent">Ready</Badge>
            ) : (
              <Badge tone="warning">Not installed</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">{app.tagline}</p>
          {app.installedVersion && (
            <p className="mt-1 text-xs text-muted">
              Version {app.installedVersion}
              {update?.updateAvailable && update.latestVersion ? <> · <b className="text-accent2">{update.latestVersion} is available</b></> : update?.latestVersion && !update.updateAvailable ? " · up to date" : ""}
            </p>
          )}
        </div>
      </div>

      {app.installed && app.path ? (
        <div className="rounded-ctl bg-elevated/60 px-3 py-2 text-xs text-muted">
          <div className="font-semibold text-fg">{app.source ? SOURCE_TEXT[app.source] : ""}</div>
          <div className="mt-0.5 truncate" title={app.path}>{app.path}</div>
        </div>
      ) : (
        <p className="rounded-ctl bg-elevated/60 px-3 py-2 text-xs text-muted">
          {installing
            ? `Installing ${app.name}… this takes a few seconds and needs no extra clicks.`
            : app.canInstall
              ? `${app.name} isn't on this PC yet. Install it right here — the setup is built into the launcher.`
              : `${app.name} isn't on this PC yet, and this copy of the launcher doesn't include its setup. Use “Locate…” if it's saved somewhere else.`}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {app.installed && update?.updateAvailable && (
          <Button variant="primary" icon={<Download size={16} />} loading={updating} disabled={installing} onClick={() => void runUpdate()}>
            {updating ? "Updating…" : `Update to ${update.latestVersion}`}
          </Button>
        )}
        {!app.installed && (
          <Button variant="primary" icon={<Download size={16} />} loading={installing} disabled={!app.canInstall} onClick={() => void install()}>
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
        <Button variant={app.installed && !update?.updateAvailable ? "primary" : "secondary"} icon={<Play size={16} />} loading={busy} disabled={!app.installed || installing || updating} onClick={() => void launch()}>
          {app.running ? "Open again" : "Launch"}
        </Button>
        {app.installed && app.source !== "installed" && app.canInstall && (
          <Button variant="secondary" icon={<Download size={16} />} loading={installing} onClick={() => void install()}>
            Install on this PC
          </Button>
        )}
        <Button variant="secondary" icon={<FolderSearch size={16} />} disabled={installing || updating} onClick={() => void locate()}>
          Locate…
        </Button>
        {app.installed && (
          <Button variant="ghost" icon={<Folder size={16} />} onClick={() => void openFolder()}>
            Show folder
          </Button>
        )}
      </div>
    </article>
  );
}

export function OtherPage() {
  const [apps, setApps] = useState<OtherApp[] | null>(null);
  const [error, setError] = useState("");
  const [updates, setUpdates] = useState<OtherUpdate[]>([]);
  const [checking, setChecking] = useState(false);
  const toast = useApp((st) => st.toast);

  const checkUpdates = useCallback(async (announce: boolean) => {
    setChecking(true);
    try {
      const found = await api.checkOtherUpdates();
      setUpdates(found);
      if (announce) {
        const newer = found.filter((u) => u.updateAvailable);
        const failed = found.find((u) => u.message && !u.latestVersion);
        if (newer.length) toast("info", newer.length === 1 ? "An update is available" : "Updates are available", "Press Update on the app's card.");
        else if (failed?.message) toast("error", "Couldn't check for updates", failed.message);
        else toast("success", "Everything is up to date");
      }
    } catch {
      if (announce) toast("error", "Couldn't check for updates");
    } finally {
      setChecking(false);
    }
  }, [toast]);

  const load = useCallback(async () => {
    try {
      setApps(await api.otherApps());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void checkUpdates(false); // quietly, when the page opens
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load, checkUpdates]);

  const reload = () => {
    void load();
    void checkUpdates(false);
  };

  return (
    <div className="page-pad">
      <PageHeader eyebrow="YOUR OTHER APPS" title="Other WIISB's">
        <Button variant="secondary" size="sm" icon={<Download size={15} />} loading={checking} onClick={() => void checkUpdates(true)}>
          Check for updates
        </Button>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={15} />} onClick={() => void load()}>
          Refresh
        </Button>
      </PageHeader>
      <p className="mb-6 max-w-2xl text-sm text-muted">
        The rest of the WIISB family. Install them straight from here — no separate downloads — then start them whenever you like. They live in their own windows and keep their own data.
      </p>
      {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
      {!apps && !error && <p className="text-sm text-muted">Looking for your WIISB apps…</p>}
      {apps && (
        <div className="grid gap-5 md:grid-cols-2">
          {apps.map((a) => (
            <AppCard key={a.id} app={a} update={updates.find((u) => u.id === a.id)} onChanged={reload} />
          ))}
        </div>
      )}
      <p className="mt-8 flex items-center gap-2 text-xs text-muted">
        <Boxes size={14} /> Only WIISB Chat and WIISBROWSING can be installed or started from here, using the setups that ship with the launcher.
      </p>
    </div>
  );
}
