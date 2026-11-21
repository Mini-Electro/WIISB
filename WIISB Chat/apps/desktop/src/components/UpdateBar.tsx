import { useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, X } from "lucide-react";

type Ready = { version: string; notes?: string | null };

/**
 * Shows "a new version is ready" once the app has downloaded and verified an update in the background.
 * Nothing restarts until the person presses the button.
 */
export function UpdateBar() {
  const [ready, setReady] = useState<Ready | null>(null),
    [dismissed, setDismissed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    void invoke<Ready | null>("pending_update")
      .then((u) => u && setReady(u))
      .catch(() => {});
    void listen<Ready>("update-ready", (e) => {
      setReady(e.payload);
      setDismissed(false);
    }).then((fn) => (off = fn));
    return () => off?.();
  }, []);
  if (!ready || dismissed) return null;
  return (
    <div className="update-bar" role="status">
      <Download size={17} />
      <span>
        <b>WIISB Chat {ready.version}</b> is ready.{" "}
        {error || "Restart to get the latest version."}
      </span>
      <button
        className="primary"
        disabled={busy}
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
        className="icon-button"
        title="Later"
        aria-label="Later"
        onClick={() => setDismissed(true)}
      >
        <X size={15} />
      </button>
    </div>
  );
}
