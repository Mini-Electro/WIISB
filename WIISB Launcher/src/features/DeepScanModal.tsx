import { useEffect, useMemo, useState } from "react";
import { HardDrive, Loader2, Search, ShieldCheck } from "lucide-react";
import { api } from "@/services/api";
import { Badge, Button, Modal, cx } from "@/components/ui";
import { useApp } from "@/stores/appStore";
import { formatBytes, formatDuration, shortPath } from "@/utils/format";
import type { DeepCandidate } from "@/types";

/** Results at or above this are ticked by default; weaker ones need a deliberate click. */
const LIKELY = 80;

function Row({ c, checked, onToggle }: { c: DeepCandidate; checked: boolean; onToggle: () => void }) {
  const likely = c.confidence >= LIKELY;
  return (
    <label className={cx("flex cursor-pointer items-start gap-3 rounded-ctl border p-3 t-transition", checked ? "border-accent bg-accent/10" : "border-line bg-elevated hover:border-line-strong")}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 h-4 w-4 accent-[var(--c-accent)]" aria-label={`Add ${c.title}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="display text-[15px] font-semibold">{c.title}</span>
          <Badge tone={likely ? "success" : "warning"}>{likely ? "Likely a game" : "Possible"}</Badge>
          <Badge>{c.engine}</Badge>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted" title={c.root}>
          {shortPath(c.root, 4)}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {c.exe.split("\\").pop()} · {formatBytes(c.size)} · {c.reasons.join(" · ")}
        </div>
      </div>
    </label>
  );
}

export function DeepScanModal() {
  const deep = useApp((s) => s.deep);
  const start = useApp((s) => s.startDeepScan);
  const cancel = useApp((s) => s.cancelDeepScan);
  const refresh = useApp((s) => s.refreshGames);
  const toast = useApp((s) => s.toast);
  const close = () => {
    // Closing while scanning stops it: nothing keeps running unseen.
    if (deep?.running) void cancel();
    useApp.getState().setModal(null);
  };

  const candidates = deep?.candidates ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // Pre-tick the likely ones whenever a new set of results arrives.
  useEffect(() => {
    setPicked(new Set(candidates.filter((c) => c.confidence >= LIKELY).map((c) => c.id)));
  }, [deep?.finished, candidates.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const selectedCount = useMemo(() => candidates.filter((c) => picked.has(c.id)).length, [candidates, picked]);

  const add = async () => {
    setAdding(true);
    try {
      const items = await api.deepScanAdd([...picked]);
      await refresh();
      useApp.setState({ deep: await api.deepScanStatus() });
      toast(items.length ? "success" : "info", items.length ? `${items.length} game${items.length === 1 ? "" : "s"} added` : "Those games were already in your library");
    } catch (e) {
      toast("error", "Couldn't add games", (e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const running = !!deep?.running;
  const finished = !!deep?.finished && !running;
  const p = deep?.progress;

  return (
    <Modal
      open
      onClose={close}
      width={680}
      title="Scan this PC for games"
      description="Looks through all your drives for installed games. Results are only suggestions — nothing is added until you choose."
      footer={
        running ? (
          <Button variant="danger" onClick={() => void cancel()}>Stop scan</Button>
        ) : finished ? (
          <>
            <Button variant="ghost" onClick={() => void start()}>Scan again</Button>
            <Button variant="secondary" onClick={close}>Close</Button>
            <Button variant="primary" loading={adding} disabled={selectedCount === 0} onClick={() => void add()}>
              Add {selectedCount || ""} selected
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" icon={<Search size={16} />} onClick={() => void start()}>Start scan</Button>
          </>
        )
      }
    >
      {!running && !finished && (
        <div className="space-y-3 text-[13px] leading-relaxed text-muted">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 shrink-0 text-success" size={18} />
            <p>
              <span className="font-semibold text-fg">Read-only and gentle.</span> Nothing is run, moved or changed. The scan uses low CPU and disk priority, skips Windows, AppData and
              cache folders, never follows shortcuts to other places, and you can stop it at any time.
            </p>
          </div>
          <div className="flex gap-3">
            <HardDrive className="mt-0.5 shrink-0 text-accent2" size={18} />
            <p>
              Games are recognised by how they're built (Unity, Unreal, GameMaker, Godot, GOG, Steamworks and more), so programs like Photoshop don't show up. Games already in
              your library are skipped. It usually takes a few minutes.
            </p>
          </div>
          <p className="text-xs">Some games can't be found: Microsoft Store / Xbox titles whose files Windows protects can't be read by other programs.</p>
        </div>
      )}

      {running && (
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="spin text-accent2" />
            <div className="display text-lg font-semibold">Scanning…</div>
            <div className="ml-auto text-[13px] tabular-nums text-muted">{formatDuration(p?.elapsedSecs ?? 0)}</div>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-line">
            <div className="skeleton absolute inset-0" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="panel p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Folders checked</div>
              <div className="display text-2xl font-semibold tabular-nums">{(p?.dirs ?? 0).toLocaleString()}</div>
            </div>
            <div className="panel p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Possible games</div>
              <div className="display text-2xl font-semibold tabular-nums">{p?.found ?? 0}</div>
            </div>
          </div>
          <div className="truncate font-mono text-[11.5px] text-muted" title={p?.current}>
            {p?.current ? shortPath(p.current, 5) : "Starting…"}
          </div>
        </div>
      )}

      {finished && (
        <div className="space-y-3">
          <div className="text-[13px] text-muted">
            Checked <span className="font-semibold text-fg">{(p?.dirs ?? 0).toLocaleString()}</span> folders in {formatDuration(p?.elapsedSecs ?? 0)}.{" "}
            {deep?.cancelled ? "You stopped the scan early, so this list may be incomplete. " : deep?.hitLimit ? "The scan reached its safety limit, so this list may be incomplete. " : ""}
            {candidates.length === 0 ? "No new games were found." : `${candidates.length} possible game${candidates.length === 1 ? "" : "s"}:`}
          </div>
          {candidates.length > 0 && (
            <>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(candidates.map((c) => c.id)))}>Select all</Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Select none</Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(candidates.filter((c) => c.confidence >= LIKELY).map((c) => c.id)))}>Likely only</Button>
              </div>
              <div className="space-y-2">
                {candidates.map((c) => (
                  <Row key={c.id} c={c} checked={picked.has(c.id)} onToggle={() => toggle(c.id)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
