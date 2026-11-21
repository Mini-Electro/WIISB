import { useEffect, useState } from "react";
import { FolderOpen, Save, Undo2 } from "lucide-react";
import { api, AppError } from "@/services/api";
import { pickExecutable, pickFolder, pickShortcut } from "@/services/dialogs";
import { Button, Segmented, TextInput } from "@/components/ui";
import { useApp } from "@/stores/appStore";
import { reveal } from "./library";
import type { Game, LaunchMethod } from "@/types";

const METHOD_HELP: Record<LaunchMethod, string> = {
  direct: "Runs the game's .exe directly with the folder below as its working directory.",
  platform: "Hands a launch link to the platform that installed the game (for example steam://rungameid/<id>). WIISB Launcher never guesses IDs — paste the link from the platform.",
  shortcut: "Opens a Windows shortcut (.lnk) exactly as a double-click would.",
};

function PathField({ value, onChange, onBrowse, placeholder, label }: { value: string; onChange: (v: string) => void; onBrowse?: () => void; placeholder?: string; label: string }) {
  return (
    <div className="flex gap-2">
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="font-mono !text-[12.5px]" />
      {onBrowse && (
        <Button variant="secondary" icon={<FolderOpen size={16} />} onClick={onBrowse}>
          Browse
        </Button>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-semibold">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-xs leading-snug text-muted">{hint}</div>}
    </div>
  );
}

/** Edit how a game is launched: method, target, installation folder, arguments, working directory. */
export function LaunchSettingsForm({ game, onSaved }: { game: Game; onSaved?: () => void }) {
  const replaceGame = useApp((s) => s.replaceGame);
  const toast = useApp((s) => s.toast);
  const running = useApp((s) => !!s.runtime[game.slug] && s.runtime[game.slug].state !== "launch_requested");

  const initial = () => ({
    method: game.launchMethod,
    target: game.launchTarget ?? "",
    installPath: game.installationPath ?? "",
    args: game.launchArgs,
    workingDir: game.workingDir ?? "",
  });
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(initial()), [game.launchTarget, game.installationPath, game.launchMethod, game.launchArgs, game.workingDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  const browseTarget = async () => {
    const p = form.method === "shortcut" ? await pickShortcut() : await pickExecutable("Select the game's executable", form.target || form.installPath || undefined);
    if (p) set("target", p);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveLaunchSettings(game.slug, {
        method: form.method,
        target: form.target,
        installPath: form.installPath.trim() || null,
        args: form.method === "direct" ? form.args : "",
        workingDir: form.workingDir.trim() || null,
      });
      replaceGame(saved);
      toast("success", "Launch settings saved");
      onSaved?.();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {running && <div className="rounded-ctl border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">Close the game before changing how it launches.</div>}
      <Field label="Launch method" hint={METHOD_HELP[form.method]}>
        <Segmented<LaunchMethod>
          label="Launch method"
          value={form.method}
          onChange={(v) => set("method", v)}
          options={[
            { value: "direct", label: "Direct executable" },
            { value: "platform", label: "Platform link" },
            { value: "shortcut", label: "Shortcut" },
          ]}
        />
      </Field>
      <Field label={form.method === "platform" ? "Launch link" : form.method === "shortcut" ? "Shortcut (.lnk)" : "Executable (.exe)"}>
        {form.method === "platform" ? (
          <TextInput value={form.target} onChange={(e) => set("target", e.target.value)} placeholder="steam://rungameid/…" aria-label="Launch link" className="font-mono !text-[12.5px]" />
        ) : (
          <PathField label="Launch target" value={form.target} onChange={(v) => set("target", v)} onBrowse={() => void browseTarget()} placeholder="E:\Games\Game\Game.exe" />
        )}
      </Field>
      <Field label="Installation folder" hint="Where the game lives. Used to detect the running game so playtime can be tracked, and for “Open installation folder”.">
        <PathField
          label="Installation folder"
          value={form.installPath}
          onChange={(v) => set("installPath", v)}
          placeholder="E:\Games\Game"
          onBrowse={() => void pickFolder("Select the installation folder", form.installPath || undefined).then((p) => p && set("installPath", p))}
        />
      </Field>
      {form.method === "direct" && (
        <Field label="Launch arguments" hint="Passed to the game as separate arguments — never through a shell. Use quotes around values with spaces.">
          <TextInput value={form.args} onChange={(e) => set("args", e.target.value)} placeholder="-windowed -w 1280" aria-label="Launch arguments" className="font-mono !text-[12.5px]" />
        </Field>
      )}
      <Field label="Working directory (optional)" hint="Defaults to the executable's folder.">
        <div className="flex gap-2">
          <div className="flex-1">
            <PathField
              label="Working directory"
              value={form.workingDir}
              onChange={(v) => set("workingDir", v)}
              placeholder="(default)"
              onBrowse={() => void pickFolder("Select the working directory", form.workingDir || undefined).then((p) => p && set("workingDir", p))}
            />
          </div>
          <Button variant="ghost" onClick={() => void reveal("working_dir", game.slug)} disabled={!game.launchTarget}>
            Open
          </Button>
        </div>
      </Field>
      {error && (
        <div role="alert" className="rounded-ctl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" icon={<Undo2 size={16} />} disabled={!dirty} onClick={() => (setForm(initial()), setError(null))}>
          Reset
        </Button>
        <Button variant="primary" icon={<Save size={16} />} loading={saving} disabled={!dirty || running || !form.target.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
