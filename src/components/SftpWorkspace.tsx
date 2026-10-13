import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { File as FileIcon, Folder, FolderUp, Shield, ShieldAlert } from "lucide-react";
import { useTextPrompt } from "../ui/confirm";
import FilePanel, { ActiveDrag, FilePanelHandle } from "./FilePanel";
import MirrorsPanel from "./MirrorsPanel";
import TransfersBar, { Transfer } from "./TransfersBar";
import { createLocalProvider } from "../fs/localProvider";
import { createRemoteProvider } from "../fs/remoteProvider";
import { dropQueued, useQueuedTransfers } from "../fs/transferQueue";
import { useElementWidth, useIsNarrow } from "../hooks/useViewport";
import { onRovingKeyDown } from "../ui/rovingKeys";

// Root (sudo) mode for the remote pane. See `sftp_set_elevated` in lib.rs.
type ElevationStatus = { elevated: boolean; passwordless: boolean };

const SUDO_MESSAGES: Record<string, string> = {
  "[SUDO] NEED_PASSWORD": "sudo needs a password.",
  "[SUDO] WRONG_PASSWORD": "Wrong sudo password.",
  "[SUDO] NOT_ALLOWED": "This user isn't allowed to run sftp-server with sudo.",
  "[SUDO] REQUIRETTY": "sudo on this server requires a terminal (requiretty), so it can't be used for file access.",
  "[SUDO] NO_SUDO": "sudo isn't installed on this server.",
  "[SUDO] NO_SFTP_SERVER": "Couldn't find the sftp-server program on this server.",
};

const describeSudoError = (raw: string) => {
  const code = Object.keys(SUDO_MESSAGES).find((k) => raw.includes(k));
  return code ? SUDO_MESSAGES[code] : raw.replace(/^\[SUDO\] FAILED:?\s*/, "sudo failed: ");
};

// Speed is measured over this trailing window of progress samples, so one
// slow or fast chunk does not make the number jump.
const SPEED_WINDOW_MS = 3000;
const SPEED_MIN_SPAN_MS = 500;

// Dual-pane SFTP workspace. Owns the two FilePanels, the cross-pane drag
// state, and the global mouseup that turns a release over the opposite pane
// into an upload / download batch run by the source panel.

interface SftpWorkspaceProps {
  sessionId: string;
  disabled?: boolean;
  // Mirror config from the parent session — both pieces are needed by the
  // (now-nested) MirrorsPanel sub-tab. Passing them through here lets us
  // collapse the previously-separate Mirror toolbar entry into one SFTP
  // umbrella ("Files" vs "Mirror" sub-tabs), so the session toolbar has
  // one fewer item to fit on phones.
  serverId?: number;
  mirrorsConfig?: any[];
  /** Focused PTY. Passed through while SFTP hides the terminal on a narrow window. */
  terminalId?: string;
  /** Compact layout: close the SFTP pane so the terminal that just received `cd` is visible. */
  onRevealTerminal?: () => void;
  /** Unlocked profile. Server ids restart in every profile's DB, so per-server storage keys need it. */
  profile: string;
}

// Profile names hold only [A-Za-z0-9_-], so ":" keeps the parts apart.
export const bookmarksKeyPrefix = (profile: string) => `submarine-sftp-bookmarks:${profile}:`;

type SftpView = "files" | "mirror";
// "split" is Local above Remote. The name predates "side" and stays because
// it is what earlier versions saved.
type FilesLayout = "tabs" | "split" | "side";
type FilesSide = "local" | "remote";

// Cursor-following drag ghost, isolated into its own component so that the
// per-mousemove position updates re-render ONLY this tiny node — not the whole
// SftpWorkspace and, through it, both (un-memoized) FilePanels with their full
// row lists. The parent drives it imperatively via the ref instead of holding
// the position in its own state.
export interface DragGhostHandle {
  show: (drag: ActiveDrag) => void;
  hide: () => void;
}

const DragGhost = forwardRef<DragGhostHandle>((_props, ref) => {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  useImperativeHandle(ref, () => ({
    show: (d) => setDrag(d),
    hide: () => setDrag(null),
  }), []);
  if (!drag) return null;
  // Rendered through a portal so any ancestor's `transform` / `backdrop-filter`
  // doesn't re-anchor the `position: fixed` element to a containing block.
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: drag.y + 8,
        left: drag.x + 12,
        pointerEvents: "none",
        zIndex: 10000,
      }}
      className="bg-[#0c0c0e]/95 border border-indigo-500/40 rounded-lg px-3 py-1.5 text-[11px] font-mono text-zinc-100 shadow-2xl backdrop-blur-md flex items-center gap-2"
    >
      <FileIcon size={12} className="text-indigo-300 shrink-0" />
      <span className="truncate max-w-[260px]">{drag.entry.name}</span>
      {drag.items.length > 1 && <span className="shrink-0 text-indigo-300">+{drag.items.length - 1}</span>}
    </div>,
    document.body
  );
});
DragGhost.displayName = "DragGhost";

const SftpWorkspace = ({ sessionId, disabled = false, serverId = 0, mirrorsConfig = [], terminalId, onRevealTerminal, profile }: SftpWorkspaceProps) => {
  // Active sub-tab. Files is the default (the common workflow); Mirror is
  // for the per-server one-way replication setup.
  const [view, setView] = useState<SftpView>("files");
  // Files layout: "tabs" (one side full height) is the default because the
  // side panel is narrow on most desktop setups and "split" squeezed each
  // FilePanel into 5-6 rows. "split" and "side" stay available for users who
  // want simultaneous Local+Remote visibility (drag-drop still works there).
  // Persisted globally (not per-session) - pure layout preference.
  const [layout, setLayout] = useState<FilesLayout>(() => {
    try {
      const v = localStorage.getItem("submarine-sftp-layout");
      return v === "split" || v === "side" ? v : "tabs";
    } catch { return "tabs"; }
  });
  const setLayoutPersisted = (l: FilesLayout) => {
    setLayout(l);
    try { localStorage.setItem("submarine-sftp-layout", l); } catch { /* quota - ignore */ }
  };
  // Two lists side by side don't fit a phone-width window: there "side"
  // shows as the stacked split, and the saved choice comes back once the
  // window is wider.
  const isNarrow = useIsNarrow();
  const shownLayout: FilesLayout = layout === "side" && isNarrow ? "split" : layout;
  // Active side in tabs mode. We persist it per (session) so the user
  // returns to the side they were last using, not always Local.
  const sideStorageKey = `submarine-sftp-side-${sessionId}`;
  const [activeSide, setActiveSide] = useState<FilesSide>(() => {
    try {
      const v = localStorage.getItem(sideStorageKey);
      return v === "remote" ? "remote" : "local";
    } catch { return "local"; }
  });
  const setActiveSidePersisted = (s: FilesSide) => {
    setActiveSide(s);
    try { localStorage.setItem(sideStorageKey, s); } catch { /* ignore */ }
  };
  // What the Local / Remote / Split / Side switcher shows as selected.
  const panelMode: FilesSide | "split" | "side" = layout === "tabs" ? activeSide : layout;
  // Files / Mirror drop to icons when the pane is dragged too narrow for
  // both the tabs and the panel switcher.
  const subBarRef = useRef<HTMLDivElement>(null);
  const subBarWidth = useElementWidth(subBarRef);
  const showSubLabels = subBarWidth >= 380;
  // Providers are created once per session so the panels' provider identity
  // is stable across renders (the FilePanel's load-on-mount effect keys off it).
  const localProvider = useMemo(() => createLocalProvider(), []);
  const remoteProvider = useMemo(() => createRemoteProvider(sessionId), [sessionId]);

  const localRef = useRef<FilePanelHandle | null>(null);
  const remoteRef = useRef<FilePanelHandle | null>(null);

  // Elevated = SFTP runs as root through sudo (passwordless or with a password
  // kept in backend memory for this tab only). A direct root login is flagged
  // with the same badge so it's always obvious when file ops have full power.
  const textPrompt = useTextPrompt();
  const [elevation, setElevation] = useState<ElevationStatus>({ elevated: false, passwordless: false });
  const [loginUser, setLoginUser] = useState<string | null>(null);
  const [elevBusy, setElevBusy] = useState(false);
  const [elevError, setElevError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ElevationStatus>("sftp_elevation_status", { sessionId })
      .then((s) => { if (!cancelled) setElevation(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    invoke<string>("sftp_login_user", { sessionId })
      .then((u) => { if (!cancelled) setLoginUser(u || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, disabled]);

  const flashElevError = (msg: string) => {
    setElevError(msg);
    window.setTimeout(() => setElevError(null), 6000);
  };

  const toggleElevation = async () => {
    if (elevBusy || disabled) return;
    setElevBusy(true);
    setElevError(null);
    try {
      if (elevation.elevated) {
        setElevation(await invoke<ElevationStatus>("sftp_set_elevated", { sessionId, enabled: false, password: null }));
      } else {
        // Passwordless sudo first; only ask for a password when sudo wants one.
        let password: string | null = null;
        for (let wrongTries = 0; ; ) {
          try {
            setElevation(await invoke<ElevationStatus>("sftp_set_elevated", { sessionId, enabled: true, password }));
            break;
          } catch (e: any) {
            const raw = String(e);
            const wrong = raw.includes("[SUDO] WRONG_PASSWORD");
            if (!wrong && !raw.includes("[SUDO] NEED_PASSWORD")) throw e;
            if (wrong && ++wrongTries >= 3) throw e;
            password = await textPrompt({
              title: "Run file operations as root",
              message: wrong
                ? "Wrong sudo password, try again."
                : "Enter your sudo password. It's kept in memory for this tab only and never saved.",
              password: true,
              keepWhitespace: true,
              okLabel: "Use sudo",
              validate: (v) => (v ? null : "Enter the password"),
            });
            if (password === null) return;
          }
        }
      }
      await remoteRef.current?.refresh();
    } catch (e: any) {
      flashElevError(describeSudoError(String(e)));
    } finally {
      setElevBusy(false);
    }
  };

  const rootByLogin = !elevation.elevated && loginUser === "root";
  const rootBadgeClass =
    "h-6 px-2 flex items-center gap-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-rose-500/20 text-rose-200 border border-rose-500/50";
  const elevationControl = (
    <div className="flex items-center gap-1.5 shrink-0 min-w-0">
      {elevation.elevated ? (
        <button
          onClick={toggleElevation}
          disabled={elevBusy}
          title={`File operations run as root via sudo${elevation.passwordless ? " (passwordless)" : ""}. Click to go back to ${loginUser || "your login user"}.`}
          className={`${rootBadgeClass} hover:bg-rose-500/30 disabled:opacity-50`}
        >
          <ShieldAlert size={11} /> root · sudo
        </button>
      ) : rootByLogin ? (
        <span title="Logged in as root: file operations run with full privileges." className={rootBadgeClass}>
          <ShieldAlert size={11} /> root
        </span>
      ) : (
        <button
          onClick={toggleElevation}
          disabled={elevBusy || disabled}
          title="Run file operations as root (sudo)"
          className="h-6 px-2 flex items-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-white/[0.04] text-zinc-300 border border-white/10 hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <Shield size={11} /> {elevBusy ? "…" : "sudo"}
        </button>
      )}
      {elevError && (
        <span className="text-[10px] text-rose-300 max-w-[220px] truncate" title={elevError}>{elevError}</span>
      )}
    </div>
  );

  // Persist the last directory each panel was in per (session, side) so the
  // user lands on the same path next time they open this server. If the
  // saved path no longer exists, FilePanel falls back to provider.homePath().
  const storageKey = `submarine-server-dirs-${sessionId}`;
  const savedDirsRef = useRef<{ local?: string; remote?: string }>(
    (() => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    })()
  );
  const saveDir = (side: "local" | "remote", path: string) => {
    savedDirsRef.current[side] = path;
    try { localStorage.setItem(storageKey, JSON.stringify(savedDirsRef.current)); }
    catch { /* quota or private-mode storage — ignore */ }
  };
  const bookmarksKey = (side: FilesSide) => `${bookmarksKeyPrefix(profile)}${sessionId}:${side}`;

  // Source of truth for the active drag. Updated SYNCHRONOUSLY from the
  // panel's onMove via the ref so the window mouseup handler (which runs in
  // the same tick as the panel's own mouseup that clears it) can still see
  // the source pane and entry. Going through React state introduces a race
  // because `setDrag → render → useEffect` doesn't always settle before the
  // mouseup propagates.
  const dragRef = useRef<ActiveDrag | null>(null);
  // The ghost owns its own position state; we poke it imperatively so a
  // mousemove never re-renders this workspace (and its FilePanels).
  const ghostRef = useRef<DragGhostHandle>(null);
  // This workspace root. Hover and mouseup ignore a [data-fs-pane] outside
  // it, so a release over a tiled neighbor session does not send files there.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Where a release over the OTHER pane would land: a folder row, the ".."
  // row or a path-bar segment, else that pane as a whole (its current
  // directory). Marked with an attribute straight on the element (styled in
  // App.css), again to keep mousemove out of React renders. A drop inside
  // the source pane is highlighted by that panel itself.
  const dropHoverElRef = useRef<Element | null>(null);
  const markDropHover = (el: Element | null) => {
    if (dropHoverElRef.current === el) return;
    dropHoverElRef.current?.removeAttribute("data-fs-drop-hover");
    el?.setAttribute("data-fs-drop-hover", "");
    dropHoverElRef.current = el;
  };

  const handleDragMove = (drag: ActiveDrag | null) => {
    dragRef.current = drag;
    if (!drag) {
      ghostRef.current?.hide();
      markDropHover(null);
      return;
    }
    ghostRef.current?.show(drag);
    const hit = document.elementFromPoint(drag.x, drag.y);
    const pane = hit?.closest("[data-fs-pane]") ?? null;
    // A pane outside this workspace belongs to a tiled neighbor session.
    if (pane && !rootRef.current?.contains(pane)) {
      markDropHover(null);
      return;
    }
    const overOtherPane = !!pane && pane.getAttribute("data-fs-pane") !== drag.paneId;
    markDropHover(overOtherPane ? hit!.closest("[data-fs-drop-path]") ?? pane : null);
  };

  // Live transfer progress, keyed by the backend-assigned id. The Rust
  // commands stream events at ~10Hz; we replace the entry on each update so
  // a single growing progress bar shows per transfer. Speed comes from the
  // (time, bytes) samples of the last few seconds.
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const speedSamplesRef = useRef(new Map<string, { t: number; bytes: number }[]>());
  const [transfersCollapsed, setTransfersCollapsed] = useState(false);
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

  // Transfers bar. Batch items carry the transfer id they are run with, so
  // a "starting" item is hidden exactly when events for that id exist (its
  // live row takes over), including between "done" and the invoke settling.
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
  const transfersBar = transferList.length + visibleQueued.length > 0 ? (
    <TransfersBar
      transfers={transferList}
      queued={visibleQueued}
      collapsed={transfersCollapsed}
      onToggleCollapsed={() => setTransfersCollapsed((c) => !c)}
      onCancel={cancelTransfer}
      onCancelQueued={cancelQueued}
    />
  ) : null;

  // Cross-pane drop dispatch: when the user releases the mouse anywhere, look
  // up which pane is under the cursor; if it differs from the source pane and
  // sits inside this workspace, run the transfer and refresh both panels.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const active = dragRef.current;
      if (!active) return;
      // Clear immediately so a second mouseup (e.g. the FilePanel's own
      // listener clearing the ghost) doesn't re-enter this branch.
      dragRef.current = null;

      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      const pane = (hit as HTMLElement).closest("[data-fs-pane]") as HTMLElement | null;
      if (!pane || !rootRef.current?.contains(pane)) return;
      const targetPaneId = pane.getAttribute("data-fs-pane");
      if (!targetPaneId || targetPaneId === active.paneId) return;

      // Same drop targets as a move inside one pane (`data-fs-drop-path`):
      // a folder row, the ".." row or a path-bar segment drops INTO that
      // folder. A file row, an empty area or the header falls back to the
      // pane's current directory.
      const dropEl = (hit as HTMLElement).closest("[data-fs-drop-path]");
      const targetDir = dropEl?.getAttribute("data-fs-drop-path")
        || pane.getAttribute("data-fs-current-path") || "";
      if (!targetDir) return;

      // Everything the ghost showed goes across: the source panel runs its
      // own upload / download batch (queue rows, overwrite prompt, folders)
      // aimed at the drop target.
      const sourceRef = active.paneId === "local" ? localRef : remoteRef;
      const run = sourceRef.current?.sendItems(active.items, targetDir) ?? Promise.resolve();
      run
        .catch((err) => {
          sourceRef.current?.notify(`Transfer failed: ${err}`, "error");
          console.error("Cross-pane transfer failed:", err);
        })
        .finally(() => {
          localRef.current?.refresh();
          remoteRef.current?.refresh();
        });
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={rootRef} className="flex-1 flex flex-col h-full overflow-hidden bg-[#0a0a0c] relative">
      {/* Sub-tab row — Files vs Mirror on the left, and for Files the
          panel switcher on the right: Local / Remote show one side at full
          height, Split stacks both (drag-drop between them). The Mirror
          panel keeps state across tab switches via CSS hidden so the live
          worker's counters and rolling log survive a switch back to Files. */}
      <div ref={subBarRef} className="shrink-0 h-11 flex items-stretch gap-2 px-2 border-b border-white/5 bg-white/[0.02]">
        <div role="tablist" aria-label="SFTP views" onKeyDown={(e) => onRovingKeyDown(e)} className="flex items-stretch min-w-0">
          {([
            { id: "files", icon: Folder, label: "Files" },
            { id: "mirror", icon: FolderUp, label: "Mirror" },
          ] as const).map(({ id, icon: Icon, label }) => {
            const on = view === id;
            const off = id === "mirror" && !serverId;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                aria-label={label}
                onClick={() => setView(id)}
                disabled={off}
                title={off ? "Mirror needs a saved server" : undefined}
                className={`relative shrink-0 px-3 flex items-center gap-2 text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  on ? "text-primary font-semibold" : "text-zinc-400 font-medium hover:text-zinc-100"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                {showSubLabels && <span>{label}</span>}
                {on && <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        {view === "files" && (
          <div role="radiogroup" aria-label="File panels" onKeyDown={(e) => onRovingKeyDown(e)} className="self-center shrink-0 flex items-center gap-0.5 p-0.5 rounded-lg border border-white/10 bg-black/20">
            {([
              { id: "local", label: "Local", hint: "Local files at full height" },
              { id: "remote", label: "Remote", hint: "Remote files at full height" },
              { id: "split", label: "Split", hint: "Show both panels stacked (drag-drop between them)" },
              { id: "side", label: "Side", hint: "Show both panels side by side (drag-drop between them)" },
            ] as const).map(({ id, label, hint }) => {
              const on = panelMode === id;
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  title={hint}
                  onClick={() => {
                    if (id === "split" || id === "side") { setLayoutPersisted(id); return; }
                    setLayoutPersisted("tabs");
                    setActiveSidePersisted(id);
                  }}
                  className={`h-7 px-3 rounded-md border text-[12.5px] font-semibold transition-colors ${
                    on
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-transparent text-zinc-300 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Files view — dual-pane browser. Stays mounted when Mirror is on top
          so directory state and selection don't reset across tab toggles.
          Both FilePanels are ALWAYS mounted (one is just CSS-hidden in
          tabs mode) so cd state, scroll position, and selection survive a
          tab toggle. */}
      <div className={`${view === "files" ? `flex-1 flex min-h-0 ${shownLayout === "side" ? "flex-row" : "flex-col"}` : "hidden"}`}>
        {/* Both panels stay mounted. Split stacks them; side puts them in a
            row. Tabs hides the inactive one with CSS so its directory and
            selection survive a side swap. */}
        <div className={
          shownLayout === "split"
            ? "flex-1 min-h-0 border-b border-white/10"
            : shownLayout === "side"
              ? "flex-1 min-w-0 min-h-0 border-r border-white/10"
              : activeSide === "local" ? "flex-1 min-h-0" : "hidden"
        }>
          <FilePanel
            ref={localRef}
            provider={localProvider}
            // The local pane also needs sessionId so its bulk-upload button can
            // invoke sftp_upload_file / sftp_upload_dir on the right session.
            // Without this the Upload button silently no-ops on the first
            // guard (`if (!sessionId) return`).
            sessionId={sessionId}
            disabled={disabled}
            onDragMove={handleDragMove}
            initialPath={savedDirsRef.current.local}
            onPathChange={(p) => saveDir("local", p)}
            getOppositeDir={() => remoteRef.current?.currentDir()}
            bookmarksKey={bookmarksKey("local")}          />
        </div>
        <div className={
          shownLayout === "split"
            ? "flex-1 min-h-0"
            : shownLayout === "side"
              ? "flex-1 min-w-0 min-h-0"
              : activeSide === "remote" ? "flex-1 min-h-0" : "hidden"
        }>
          <FilePanel
            ref={remoteRef}
            provider={remoteProvider}
            sessionId={sessionId}
            disabled={disabled}
            onDragMove={handleDragMove}
            initialPath={savedDirsRef.current.remote}
            onPathChange={(p) => saveDir("remote", p)}
            getOppositeDir={() => localRef.current?.currentDir()}
            terminalId={terminalId}
            onRevealTerminal={onRevealTerminal}
            bookmarksKey={bookmarksKey("remote")}
            headerExtra={elevationControl}
            rootMode={elevation.elevated || rootByLogin}
          />
        </div>
      </div>

      {/* Mirror view — kept MOUNTED (CSS hidden) so the live worker's logs
          and progress counters survive when the user pops back to Files. */}
      {!!serverId && (
        <div className={`${view === "mirror" ? "flex-1 flex flex-col min-h-0" : "hidden"}`}>
          <MirrorsPanel
            sessionId={sessionId}
            serverId={serverId}
            configuredMirrors={mirrorsConfig}
            disabled={disabled}
          />
        </div>
      )}

      {/* Transfers bar — docked on the workspace root, under both the Files
          and the Mirror view, so a long transfer or an editor save stays
          visible (and cancellable) whichever tab is open. */}
      {transfersBar}

      {/* Cursor-following drag ghost. Self-contained so its per-mousemove
          position updates don't re-render this workspace or the FilePanels. */}
      <DragGhost ref={ghostRef} />
    </div>
  );
};

export default SftpWorkspace;
