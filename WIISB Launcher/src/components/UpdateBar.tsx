import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Ready = { version: string; notes?: string | null };

/**
 * "A new version is ready" — shown once the app has downloaded and verified an update in the background.
 * Nothing restarts until the person presses the button.
 */
export function UpdateBar() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    invoke<Ready | null>("pending_update")
      .then((u) => u && setReady(u))
      .catch(() => {});
    listen<Ready>("update-ready", (e) => {
      setReady(e.payload);
      setDismissed(false);
    }).then((fn) => (off = fn));
    return () => off?.();
  }, []);
  if (!ready || dismissed) return null;
  return (
    <div
      role="status"
      className="fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-accent/40 bg-elevated py-2.5 pl-4 pr-2.5 text-sm text-fg shadow-2xl"
    >
      <span>
        <b>WIISB Launcher {ready.version}</b> is ready. {error || "Restart to get the latest version."}
      </span>
      <button
        disabled={busy}
        className="whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-onaccent disabled:opacity-50"
        onClick={() => {
          setBusy(true);
          setError("");
          invoke("install_update").catch((e) => {
            setBusy(false);
            setError(String(e));
          });
        }}
      >
        {busy ? "Updating…" : "Restart to update"}
      </button>
      <button
        aria-label="Later"
        title="Later"
        className="rounded-lg px-2 py-1 text-muted hover:text-fg"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  );
}
