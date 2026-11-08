import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronUp, Clock, Download, ExternalLink, Upload, X } from "lucide-react";
import { dropQueued, useQueuedTransfers, type QueuedTransfer } from "../fs/transferQueue";

// Docked transfers section at the bottom of the SFTP file card. One row per
// live upload/download (from `sftp-transfer-<session>` events), then the
// batch items still waiting their turn. Speed and time left are computed here
// from the progress samples; the backend only sends bytes. The events, and the
// state they fill, live in this component and not in SftpWorkspace: ~10 of
// them a second then redraw this bar and not the workspace with both file lists.

// Speed is measured over this trailing window of progress samples, so one
// slow or fast chunk does not make the number jump.
const SPEED_WINDOW_MS = 3000;
const SPEED_MIN_SPAN_MS = 500;

export interface Transfer {
  id: string;
  name: string;
  kind: "upload" | "download";
  bytes: number;
  total: number;
  status: "progress" | "done" | "error" | "cancelled";
  /** Why it failed. On "cancelled", what the cancel could not clean up. On "done", a note such as skipped file names. */
  error?: string;
  /** "sync": a save from the live-edit editor copy. It cannot be cancelled. */
  source?: "sync";
  /** An open-in-editor download is installed and the editor is launching. It cannot be cancelled. */
  launching?: boolean;
  /** Bytes per second over the last few seconds; unset until there is enough data. */
  speed?: number;
}

interface TransfersViewProps {
  transfers: Transfer[];
  queued: QueuedTransfer[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCancel: (id: string) => void;
  /** Removes a batch item that has no live row yet (queued or starting). */
  onCancelQueued: (id: string) => void;
}

export const formatBytes = (n: number) => {
  if (!n) return "0 B";
  const k = 1024, units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatSpeed = (bps: number) => `${formatBytes(bps)}/s`;

const formatEta = (seconds: number) => {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m ${String(s % 60).padStart(2, "0")}s left`;
  const h = Math.floor(m / 60);
  return `~${h}h ${String(m % 60).padStart(2, "0")}m left`;
};

// The bar for one session: owns the live transfers, the queued items it
// shows, and whether it is collapsed. Renders nothing while both are empty.
const TransfersBar = ({ sessionId }: { sessionId: string }) => {
  // Live transfer progress, keyed by the backend-assigned id. The Rust
  // commands stream events at ~10Hz; we replace the entry on each update so
  // a single growing progress bar shows per transfer. Speed comes from the
  // (time, bytes) samples of the last few seconds.
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const speedSamplesRef = useRef(new Map<string, { t: number; bytes: number }[]>());
  const [collapsed, setCollapsed] = useState(false);
  const queued = useQueuedTransfers(sessionId);

  // Bytes/second over the samples of the last SPEED_WINDOW_MS. Every sample
  // older than the window is dropped, even if only the new one is left, so a
  // pause (a long folder walk before the first byte) never counts as
  // transfer time. Undefined until the window spans SPEED_MIN_SPAN_MS.
  const measureSpeed = (id: string, bytes: number): number | undefined => {
    const now = performance.now();
    const samples = speedSamplesRef.current.get(id) ?? [];
    samples.push({ t: now, bytes });
    while (now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
    speedSamplesRef.current.set(id, samples);
    const span = now - samples[0].t;
    return span >= SPEED_MIN_SPAN_MS ? ((bytes - samples[0].bytes) * 1000) / span : undefined;
  };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<Transfer>(`sftp-transfer-${sessionId}`, (event) => {
      const t = event.payload;
      if (!t || !t.id) return;
      const measured = t.status === "progress" ? measureSpeed(t.id, t.bytes) : undefined;
      if (t.status !== "progress") speedSamplesRef.current.delete(t.id);
      setTransfers((prev) => {
        // Until the window spans SPEED_MIN_SPAN_MS again (e.g. right after
        // a folder walk), keep the last measured speed rather than blank it.
        const speed = t.status === "progress" ? measured ?? prev[t.id]?.speed : undefined;
        return { ...prev, [t.id]: { ...t, speed } };
      });
      if (t.status === "done" || t.status === "error" || t.status === "cancelled") {
        // Leave the final state visible briefly before clearing the card so
        // the user sees the success tick / failure colour / cancel notice.
        // A cancel that left something behind says so as long as an error.
        const linger = t.status === "error" || t.error ? 6000 : t.status === "cancelled" ? 3000 : 1800;
        setTimeout(() => {
          setTransfers((prev) => {
            const { [t.id]: _, ...rest } = prev;
            return rest;
          });
        }, linger);
      }
    }).then((fn) => {
      // Unmounted (or session changed) before listen() resolved.
      if (!alive) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  const cancelTransfer = (id: string) => {
    // Fire-and-forget: the backend emits its own "cancelled" event when the
    // loop notices the flag, which is what wipes the card.
    invoke("sftp_cancel_transfer", { transferId: id }).catch(() => {});
  };

  // Batch items carry the transfer id they are run with, so a "starting" item
  // is hidden exactly when events for that id exist (its live row takes
  // over), including between "done" and the invoke settling.
  const transferList = Object.values(transfers);
  const visibleQueued = queued.filter((q) => !(q.id in transfers));
  // Removing an item from the queue makes the batch skip it; one that is
  // already starting may have reached the backend, so cancel that id too.
  // If its command has not registered yet, the backend keeps the cancel in
  // `early_cancels` and the command starts with its flag set; if it has
  // already finished, that entry just expires.
  const cancelQueued = (id: string) => {
    const wasStarting = queued.some((q) => q.id === id && q.state === "starting");
    dropQueued(sessionId, [id]);
    if (wasStarting) cancelTransfer(id);
  };
  if (transferList.length + visibleQueued.length === 0) return null;
  return (
    <TransfersView
      transfers={transferList}
      queued={visibleQueued}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      onCancel={cancelTransfer}
      onCancelQueued={cancelQueued}
    />
  );
};

const TransfersView = ({ transfers, queued, collapsed, onToggleCollapsed, onCancel, onCancelQueued }: TransfersViewProps) => {
  const active = transfers.filter((t) => t.status === "progress" && !t.launching);
  const launching = transfers.filter((t) => t.status === "progress" && t.launching).length;
  const starting = queued.filter((q) => q.state === "starting");
  const waiting = queued.filter((q) => q.state === "queued");
  const count = (kind: "upload" | "download") =>
    active.filter((t) => t.kind === kind).length + starting.filter((q) => q.kind === kind).length;
  const downloading = count("download");
  const uploading = count("upload");
  const failed = transfers.filter((t) => t.status === "error").length;
  const summary = [
    downloading ? `${downloading} downloading` : null,
    uploading ? `${uploading} uploading` : null,
    launching ? `${launching} opening in editor` : null,
    waiting.length ? `${waiting.length} queued` : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean).join(" · ") || "Finished";
  const totalSpeed = active.reduce((sum, t) => sum + (t.speed ?? 0), 0);

  return (
    <div className="shrink-0 border-t border-white/10 bg-[#0f0f12] font-mono">
      <button
        type="button"
        onClick={onToggleCollapsed}
        title={collapsed ? "Show transfers" : "Hide transfers"}
        className="w-full h-9 sm:h-8 px-3 flex items-center gap-2 text-[10.5px] text-zinc-400 hover:bg-white/[0.03] text-left"
      >
        <span className="font-bold uppercase tracking-wider text-[9.5px] text-zinc-100 shrink-0">Transfers</span>
        <span className="w-px h-3 bg-white/10 shrink-0" />
        <span className="truncate min-w-0 flex-1">{summary}</span>
        {totalSpeed > 0 && <span className="text-zinc-200 shrink-0">{formatSpeed(totalSpeed)}</span>}
        {collapsed
          ? <ChevronUp size={12} className="shrink-0 text-zinc-400" />
          : <ChevronDown size={12} className="shrink-0 text-zinc-400" />}
      </button>

      {!collapsed && (
        <div className="max-h-[40vh] sm:max-h-56 overflow-y-auto border-t border-white/5 divide-y divide-white/5">
          {transfers.map((t) => <TransferRow key={t.id} t={t} onCancel={onCancel} />)}
          {starting.map((q) => <QueuedRow key={q.id} q={q} onCancel={onCancelQueued} />)}
          {waiting.map((q) => <QueuedRow key={q.id} q={q} onCancel={onCancelQueued} />)}
        </div>
      )}
    </div>
  );
};

const TransferRow = ({ t, onCancel }: { t: Transfer; onCancel: (id: string) => void }) => {
  const pct = t.total > 0 ? Math.min(100, (t.bytes * 100) / t.total) : null;
  const launching = t.status === "progress" && t.launching;
  // No byte and no size yet (an open waiting for its lock, a folder walk):
  // an empty bar, so the row does not flash the sweep before the size arrives.
  const starting = t.status === "progress" && t.bytes === 0 && t.total === 0;
  const Icon =
    t.status === "error"     ? AlertTriangle :
    t.status === "done"      ? Check :
    t.status === "cancelled" ? Ban :
    launching                ? ExternalLink :
    t.kind   === "upload"    ? Upload :
                               Download;
  const iconTone =
    t.status === "error"     ? "text-rose-400" :
    t.status === "done"      ? "text-emerald-400" :
    t.status === "cancelled" ? "text-amber-400" :
    t.kind   === "upload"    ? "text-sky-400" :
                               "text-blue-400";
  const barTone =
    t.status === "done"      ? "bg-emerald-500" :
    t.status === "cancelled" ? "bg-amber-500" :
                               "bg-blue-500";
  const statusLabel =
    t.status === "error"     ? <span className="text-rose-400">Failed</span> :
    t.status === "done"      ? <span className="text-emerald-400">Done</span> :
    t.status === "cancelled" ? <span className="text-amber-400">Cancelled</span> :
    launching                ? <span className="text-blue-400">Opening in editor…</span> :
    starting                 ? <span className="text-zinc-400">Starting…</span> :
    pct !== null             ? <span className="text-blue-400">{Math.floor(pct)}%</span> :
                               null;
  const sizeText = t.total > 0 ? `${formatBytes(t.bytes)} / ${formatBytes(t.total)}` : formatBytes(t.bytes);
  const rate = t.status === "progress" && !launching && t.speed && t.speed > 0
    ? [formatSpeed(t.speed), t.total > t.bytes ? formatEta((t.total - t.bytes) / t.speed) : null].filter(Boolean).join(" · ")
    : null;

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Icon size={14} className={`shrink-0 ${iconTone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="truncate min-w-0 text-zinc-100" title={t.name}>{t.name}</span>
          {t.source === "sync" && (
            <span
              className="shrink-0 px-1 rounded border border-sky-500/30 bg-sky-500/10 text-[9px] uppercase tracking-wider text-sky-300"
              title="Saved in the editor; uploading the new version"
            >
              Auto-sync
            </span>
          )}
          <span className="flex-1" />
          <span className="shrink-0 text-[10.5px] font-bold">{statusLabel}</span>
        </div>
        {t.status !== "error" && (
          <div className="relative h-1 my-1 bg-white/10 rounded overflow-hidden">
            {pct === null && t.status === "progress" && !starting ? (
              <div className="absolute inset-y-0 left-0 w-1/3 bg-blue-500/70 open-progress-indeterminate" />
            ) : (
              <div
                className={`h-full ${barTone}`}
                style={{ width: `${t.status === "progress" ? pct ?? 0 : 100}%` }}
              />
            )}
          </div>
        )}
        {t.status === "error" ? (
          <div className="mt-0.5 text-[10px] text-rose-300/90 line-clamp-3 [overflow-wrap:anywhere]" title={t.error}>{t.error || "Transfer failed"}</div>
        ) : (t.status === "cancelled" || t.status === "done") && t.error ? (
          <div className="mt-0.5 text-[10px] text-amber-300/90 line-clamp-3 [overflow-wrap:anywhere]" title={t.error}>{t.error}</div>
        ) : (
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="truncate flex-1">{sizeText}</span>
            {rate && <span className="shrink-0">{rate}</span>}
          </div>
        )}
      </div>
      {t.status === "progress" && t.source !== "sync" && !launching ? (
        <button
          type="button"
          onClick={() => onCancel(t.id)}
          title="Cancel"
          className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-white/10"
        >
          <X size={13} />
        </button>
      ) : (
        <span className="shrink-0 w-[25px]" />
      )}
    </div>
  );
};

const QueuedRow = ({ q, onCancel }: { q: QueuedTransfer; onCancel: (id: string) => void }) => {
  const starting = q.state === "starting";
  const size = q.isDir ? "Folder" : q.size !== undefined ? formatBytes(q.size) : null;
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {starting
        ? (q.kind === "upload" ? <Upload size={14} className="shrink-0 text-sky-400" /> : <Download size={14} className="shrink-0 text-blue-400" />)
        : <Clock size={14} className="shrink-0 text-zinc-500" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-zinc-100" title={q.name}>{q.name}</div>
        <div className="truncate text-[10px] text-zinc-500">
          {[size, starting ? "Starting…" : "Waiting for a transfer slot"].filter(Boolean).join(" · ")}
        </div>
      </div>
      <span className="shrink-0 text-[10.5px] text-zinc-400">{starting ? "" : "Queued"}</span>
      <button
        type="button"
        onClick={() => onCancel(q.id)}
        title={starting ? "Cancel" : "Remove from queue"}
        className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-white/10"
      >
        <X size={13} />
      </button>
    </div>
  );
};

export default TransfersBar;
