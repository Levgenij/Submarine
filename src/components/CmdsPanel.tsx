import { Fragment, useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseCommandScope, scopeMatches, scopeToJson, serverScopeIds } from "../util/commandScope";
import { invoke } from "@tauri-apps/api/core";
import { Play, RefreshCw, Search, X, Terminal, StickyNote, ClipboardCopy, ChevronDown, ChevronRight, Pencil, Check, Server, History, BookmarkPlus, Trash2 } from "lucide-react";
import { CMD_HISTORY_CHANGED, relTime, type CmdHistoryEntry } from "./HistorySearchOverlay";
import { useConfirm } from "../ui/confirm";

// Side panel that opens from a terminal session and surfaces *both* the
// user's saved Quick Commands and their Notes. Two patterns for editing:
//
//   - Notes are edit-by-default: clicking a row expands it directly into an
//     editable title input + body textarea. No Edit toggle. Save lights up
//     only when the draft diverges from the stored copy, and collapsing the
//     row or switching tabs auto-saves any pending changes so the user
//     can't lose work by clicking away.
//
//   - Commands stay compact by default (one-liner row + action buttons),
//     because they're typically short and a dropped-in textarea per item
//     would bloat the list. An Edit button on each row toggles the same
//     inline editor for that command.
//
// Both kinds get Play (write + CR → execute), Paste (write without CR →
// drop into the prompt for review), and Copy (clipboard) actions. Search
// runs client-side over the active tab's title + body fields.
//
// A History tab lists the commands typed into the terminals (cmd_history,
// the same rows Ctrl+R searches), this server's only by default. Each row
// can be run, pasted, or saved as a command through a small inline form,
// and removed from its right-click menu; Clear empties this server's
// history, or all of it.

// `scope`: which servers it's for (util/commandScope), as stored.
interface CommandItem { id: number; title: string; content: string; scope?: string | null; }
interface NoteItem { id: number; title: string; body: string; }
type Tab = "commands" | "notes" | "history" | "node";

// The history row being saved as a command. `scope`: for this server only,
// or for every server.
type AddTarget = { id: number; title: string; body: string; scope: "server" | "all" };

// Single shared "what's being edited right now" slot. Only one row can be
// editing at a time (notes expand-to-edit, commands toggle-to-edit), so a
// flat tagged union is simpler than two parallel sets of useState fields.
type EditTarget =
  | { kind: "command"; id: number; title: string; body: string }
  | { kind: "note"; id: number; title: string; body: string };

// `headerActions`: extra title-bar buttons from the session view (full screen),
// shown just before Close.
export const CmdsPanel = ({ activeTab, onClose, headerActions, serverId, serverName }: { activeTab: string; onClose: () => void; headerActions?: React.ReactNode; serverId?: number; serverName?: string }) => {
  const [tab, setTab] = useState<Tab>("commands");
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  // This session's server and its folders, by uuid, for the commands that
  // are for some servers only (util/commandScope). Null: not a saved server.
  const [scopeIds, setScopeIds] = useState<{ server: string | null; folders: string[] } | null>(null);

  // Node notes — the per-server free-form notes from AddNodePanel, surfaced
  // here so the user can read/edit them next to commands + notes without
  // bouncing back to the server editor. Source of truth is the same SQLite
  // column (servers.notes) — we fetch via get_servers and save via
  // set_server_notes. `nodeOriginal` mirrors the persisted copy so Save lights
  // up only when the draft diverges (same dirty-check pattern as commands/notes).
  const hasNode = typeof serverId === "number" && serverId > 0;
  const [nodeDraft, setNodeDraft] = useState<string>("");
  const [nodeOriginal, setNodeOriginal] = useState<string>("");
  const [nodeSaving, setNodeSaving] = useState(false);
  const nodeDraftRef = useRef<string>("");
  useEffect(() => { nodeDraftRef.current = nodeDraft; }, [nodeDraft]);

  // History is read again each time the tab opens, so it shows what was
  // just typed; the rest of the Library loads once per server.
  const [history, setHistory] = useState<CmdHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [onlyThisServer, setOnlyThisServer] = useState(true);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  // Right-click menu on a history row, at the pointer.
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number; entry: CmdHistoryEntry } | null>(null);
  const historyMenuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const confirm = useConfirm();

  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [saving, setSaving] = useState(false);
  // Ref mirror of the edit slot so the cleanup logic in tab-switch /
  // refresh / unmount can read the latest draft without re-binding the
  // effect on every keystroke.
  const editRef = useRef<EditTarget | null>(null);
  useEffect(() => { editRef.current = edit; }, [edit]);

  // Snapshot of the saved title/body for the row currently being edited.
  // Used to gate the Save button (only enabled when the draft differs) and
  // to know whether an auto-save should fire on collapse.
  const originalForEdit = (target: EditTarget): { title: string; body: string } | null => {
    if (target.kind === "command") {
      const c = commands.find((x) => x.id === target.id);
      return c ? { title: c.title || "", body: c.content || "" } : null;
    }
    const n = notes.find((x) => x.id === target.id);
    return n ? { title: n.title || "", body: n.body || "" } : null;
  };

  const isDirty = (target: EditTarget | null): boolean => {
    if (!target) return false;
    const o = originalForEdit(target);
    if (!o) return false;
    return o.title !== target.title || o.body !== target.body;
  };

  const fetchAll = async () => {
    setLoading(true);
    try {
      const tasks: Promise<any>[] = [
        invoke<CommandItem[]>("get_commands"),
        invoke<NoteItem[]>("get_notes"),
      ];
      // Pull node notes from get_servers when this Library is scoped to a
      // session. The backend exposes only the bulk list — cheap enough
      // (handful of rows) and avoids a new single-server command.
      // And the folders, for which of the commands are for this server.
      if (hasNode) tasks.push(invoke<any[]>("get_servers"), invoke<any[]>("get_folders"));
      const out = await Promise.all(tasks);
      setCommands((out[0] as CommandItem[]) || []);
      setNotes((out[1] as NoteItem[]) || []);
      if (hasNode) {
        const servers = (out[2] as any[]) || [];
        const server = servers.find((s) => s.id === serverId);
        const text: string = server?.notes ?? "";
        setNodeOriginal(text);
        setNodeDraft(text);
        setScopeIds(server ? serverScopeIds(server, (out[3] as any[]) || []) : null);
      } else {
        setScopeIds(null);
      }
    } catch (e) {
      console.error("Failed to fetch Library data:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, [serverId]);

  // This server's rows, or all of them: the table is capped at 1000 rows
  // (CMD_HISTORY_CAP in lib.rs), so search can stay client-side like the
  // other tabs. Only the latest request lands: `historySeq` moves on with
  // each one (and with a delete), so an older reply arriving late can't
  // overwrite a newer list or bring back a deleted row. The list shows a
  // spinner only until the first reply (`historyLoaded`); after that the
  // rows already there stay up while they're re-read. `quiet` leaves the
  // Refresh button still.
  const historySeq = useRef(0);
  const fetchHistory = async (quiet = false) => {
    const seq = ++historySeq.current;
    if (!quiet) setHistoryLoading(true);
    try {
      const rows = await invoke<CmdHistoryEntry[]>("cmd_history_list", {
        query: null,
        serverId: hasNode && onlyThisServer ? serverId : null,
        limit: 1000,
      });
      if (seq === historySeq.current) setHistory(rows || []);
    } catch (e) {
      console.error("Failed to fetch command history:", e);
    } finally {
      if (seq === historySeq.current) {
        setHistoryLoading(false);
        setHistoryLoaded(true);
      }
    }
  };

  // Read on opening the tab and whenever what it lists changes; while it's
  // open, a command just typed in any terminal shows up without a refresh.
  useEffect(() => {
    if (tab !== "history") return;
    void fetchHistory();
    // A command typed on another server can't change this server's list.
    const onChanged = (e: Event) => {
      const typedOn = (e as CustomEvent<number | null>).detail;
      if (hasNode && onlyThisServer && typedOn !== serverId) return;
      void fetchHistory(true);
    };
    window.addEventListener(CMD_HISTORY_CHANGED, onChanged);
    return () => window.removeEventListener(CMD_HISTORY_CHANGED, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, onlyThisServer, serverId]);

  // The add form was opened for the server it was on.
  useEffect(() => { setAdding(null); }, [serverId]);

  const isNodeDirty = nodeDraft !== nodeOriginal;
  const saveNodeNotes = async () => {
    if (!hasNode || nodeSaving || !isNodeDirty) return;
    setNodeSaving(true);
    try {
      await invoke("set_server_notes", { id: serverId, notes: nodeDraft });
      setNodeOriginal(nodeDraft);
    } catch (e) {
      console.error("Failed to save node notes:", e);
    } finally {
      setNodeSaving(false);
    }
  };

  // Save the currently editing row (if dirty), without touching the edit
  // state itself — the caller decides whether to collapse afterwards. We
  // accept a target arg so callers that already cleared local state can
  // still pass through their snapshot.
  const flushIfDirty = async (target: EditTarget | null) => {
    if (!target) return;
    const o = originalForEdit(target);
    if (!o || (o.title === target.title && o.body === target.body)) return;
    try {
      if (target.kind === "command") {
        await invoke("edit_command", { id: target.id, title: target.title, content: target.body });
        setCommands((prev) => prev.map((c) => c.id === target.id ? { ...c, title: target.title, content: target.body } : c));
      } else {
        await invoke("edit_note", { id: target.id, title: target.title, body: target.body });
        setNotes((prev) => prev.map((n) => n.id === target.id ? { ...n, title: target.title, body: target.body } : n));
      }
    } catch (e) {
      console.error("Failed to auto-save:", e);
    }
  };

  // Tab switch: persist whatever's open in the current tab before clearing
  // the editor and search so the next tab starts clean. Also auto-saves
  // pending node-notes draft when leaving the Node tab so the user can't
  // lose work by switching tabs.
  useEffect(() => {
    const snapshot = editRef.current;
    setSearchQuery("");
    setEdit(null);
    setAdding(null);
    setHistoryMenu(null);
    flushIfDirty(snapshot);
    if (hasNode && nodeDraftRef.current !== nodeOriginal) {
      void saveNodeNotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const beginEditCommand = (c: CommandItem) => {
    setEdit({ kind: "command", id: c.id, title: c.title || "", body: c.content || "" });
  };
  const beginEditNote = (n: NoteItem) => {
    setEdit({ kind: "note", id: n.id, title: n.title || "", body: n.body || "" });
  };

  const cancelEdit = () => {
    setEdit(null);
  };

  // Collapse the currently expanded note (auto-saves on the way out). Used
  // when the user clicks the chevron-area of an expanded note to retract it.
  const collapseEditedNote = async () => {
    const snapshot = editRef.current;
    setEdit(null);
    await flushIfDirty(snapshot);
  };

  const saveEdit = async () => {
    if (!edit || saving) return;
    setSaving(true);
    try {
      if (edit.kind === "command") {
        await invoke("edit_command", { id: edit.id, title: edit.title, content: edit.body });
        setCommands((prev) => prev.map((c) => c.id === edit.id ? { ...c, title: edit.title, content: edit.body } : c));
      } else {
        await invoke("edit_note", { id: edit.id, title: edit.title, body: edit.body });
        setNotes((prev) => prev.map((n) => n.id === edit.id ? { ...n, title: edit.title, body: edit.body } : n));
      }
      setEdit(null);
      fetchAll();
    } catch (e) {
      console.error("Failed to save:", e);
    } finally {
      setSaving(false);
    }
  };

  // Write `text` into the active PTY. `execute=true` appends a CR so the
  // shell runs the line immediately; false leaves the cursor at the end so
  // the user can review / edit before pressing Enter themselves.
  const writeToTerminal = async (text: string, execute: boolean) => {
    if (!activeTab) return;
    try {
      const payload = execute
        ? (text.endsWith("\n") || text.endsWith("\r") ? text : text + "\r")
        : text;
      const dataBytes = Array.from(new TextEncoder().encode(payload));
      await invoke("write_terminal_data", { terminalId: activeTab, data: dataBytes });
    } catch (e) {
      console.error("Failed to write to terminal:", e);
    }
  };

  const copyToClipboard = async (text: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { console.error("Clipboard write failed:", e); }
  };

  // Saving a history row as a command. "This server" scopes it to the
  // session's server by uuid (util/commandScope, the same shape the main
  // app's command editor stores); a quick-connect session has none, so it
  // can only be for every server.
  const canScopeToServer = !!scopeIds?.server;
  const beginAdd = (h: CmdHistoryEntry) => {
    // By code point, so an emoji at the cut isn't split in half.
    const chars = Array.from(h.command);
    const title = chars.length > 40 ? `${chars.slice(0, 40).join("").trimEnd()}…` : h.command;
    setAdding({ id: h.id, title, body: h.command, scope: canScopeToServer ? "server" : "all" });
  };
  const canSaveAdd = (a: AddTarget) => !!a.title.trim() && !!a.body.trim();
  const saveAdd = async () => {
    if (!adding || saving || !canSaveAdd(adding)) return;
    setSaving(true);
    try {
      const scope = adding.scope === "server" && scopeIds?.server ? { servers: [scopeIds.server], folders: [] } : null;
      await invoke("add_command", { title: adding.title.trim(), content: adding.body, scope: scopeToJson(scope) });
      setAdding(null);
      // Just the commands: fetchAll would also reset a Node draft whose
      // save on leaving that tab hasn't landed (or failed).
      setCommands((await invoke<CommandItem[]>("get_commands")) || []);
    } catch (e) {
      console.error("Failed to save command:", e);
    } finally {
      setSaving(false);
    }
  };

  const clearHistory = async (count: number) => {
    const serverOnly = hasNode && onlyThisServer;
    const ok = await confirm({
      title: "Clear history?",
      message: serverOnly
        ? `${count} command${count === 1 ? "" : "s"} typed on ${serverName || `Node #${serverId}`} will be removed from this device.`
        : `All ${count} command${count === 1 ? "" : "s"} in history will be removed from this device.`,
      okLabel: "Clear",
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke("cmd_history_clear", { serverId: serverOnly ? serverId : null });
    } catch (e) {
      console.error("Failed to clear command history:", e);
    }
    setAdding(null);
    fetchHistory();
  };

  const openHistoryMenu = (e: React.MouseEvent, entry: CmdHistoryEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 160, MENU_H = 40;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 4);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 4);
    setHistoryMenu({ x: Math.max(4, x), y: Math.max(4, y), entry });
  };

  // A click anywhere else, Esc, or scrolling the list closes the menu. Only
  // this list's scroll: a terminal next to it scrolls on every line of
  // output and would close the menu as soon as it opened.
  useEffect(() => {
    if (!historyMenu) return;
    const close = () => setHistoryMenu(null);
    const onMouseDown = (ev: MouseEvent) => {
      if (historyMenuRef.current?.contains(ev.target as Node)) return;
      close();
    };
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    const list = listRef.current;
    const timer = setTimeout(() => window.addEventListener("mousedown", onMouseDown), 50);
    window.addEventListener("keydown", onKeyDown);
    list?.addEventListener("scroll", close);
    window.addEventListener("blur", close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      list?.removeEventListener("scroll", close);
      window.removeEventListener("blur", close);
    };
  }, [historyMenu]);

  // Drops the row right away, then re-reads the list as stored, which also
  // puts the row back if the delete failed. Moving `historySeq` on first
  // discards a reply already in flight that still holds the row.
  const deleteHistoryEntry = async (entry: CmdHistoryEntry) => {
    setHistoryMenu(null);
    if (adding?.id === entry.id) setAdding(null);
    historySeq.current++;
    setHistory((prev) => prev.filter((h) => h.id !== entry.id));
    try {
      await invoke("cmd_history_delete", { id: entry.id });
    } catch (e) {
      console.error("Failed to delete history entry:", e);
    }
    fetchHistory(true);
  };

  const q = searchQuery.toLowerCase();
  // Commands for this server first (#22), then those for every server; the
  // ones for other servers aren't shown. A session that isn't a saved server
  // (quick connect) shows those for every server. The same split tells the
  // History tab which commands are already saved here: one kept for other
  // servers can still be saved for this one.
  const { serverCommands, everyServerCommands, savedContents } = useMemo(() => {
    const serverCommands: CommandItem[] = [];
    const everyServerCommands: CommandItem[] = [];
    for (const c of commands) {
      const s = parseCommandScope(c.scope);
      if (!s) everyServerCommands.push(c);
      else if (scopeIds && scopeMatches(s, scopeIds)) serverCommands.push(c);
    }
    const savedContents = new Set([...serverCommands, ...everyServerCommands].map((c) => c.content.trim()));
    return { serverCommands, everyServerCommands, savedContents };
  }, [commands, scopeIds]);
  const matches = (c: CommandItem) => c.title.toLowerCase().includes(q) || c.content.toLowerCase().includes(q);
  const forThisServer = serverCommands.filter(matches);
  const filteredCommands = [...forThisServer, ...everyServerCommands.filter(matches)];
  const headingAt = (i: number) =>
    forThisServer.length === 0 ? null : i === 0 ? "For this server" : i === forThisServer.length ? "All servers" : null;
  const filteredNotes = notes.filter(
    (n) => (n.title || "").toLowerCase().includes(q) || (n.body || "").toLowerCase().includes(q)
  );
  const filteredHistory = history.filter((h) => h.command.toLowerCase().includes(q));

  // The tab strip, in order. `badge`: the count, or the Node tab's unsaved dot.
  const tabs: { id: Tab; icon: typeof Terminal; label: string; badge?: ReactNode }[] = [
    { id: "commands", icon: Terminal, label: "Commands", badge: <span className="text-[9px] opacity-60 shrink-0">{commands.length}</span> },
    { id: "notes", icon: StickyNote, label: "Notes", badge: <span className="text-[9px] opacity-60 shrink-0">{notes.length}</span> },
    { id: "history", icon: History, label: "History" },
    ...(hasNode ? [{ id: "node" as const, icon: Server, label: "Node", badge: isNodeDirty && <span className="text-[9px] text-amber-400 shrink-0">●</span> }] : []),
  ];
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const tabLabel = current.label;
  const TabIcon = current.icon;
  const listLoading = tab === "history" ? !historyLoaded : loading;
  const refreshing = tab === "history" ? historyLoading : loading;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#09090b]">
      {/* Title Bar */}
      <div className="h-12 px-4 shrink-0 flex items-center justify-between border-b border-white/5 bg-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <TabIcon size={14} className="text-primary shrink-0" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300 truncate">
            Library · {tabLabel}{tab === "node" && serverName ? ` · ${serverName}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              // History is its own list; re-reading the rest would only reset
              // the Node draft under a save still on its way.
              if (tab === "history") { fetchHistory(); return; }
              await flushIfDirty(editRef.current);
              fetchAll();
            }}
            disabled={refreshing}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-all disabled:opacity-50"
            title="Refresh list"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
          {headerActions}
          <button
            onClick={async () => { await flushIfDirty(editRef.current); onClose(); }}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-all"
            title="Close Panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Tabs — four when a server is in scope (Commands / Notes / History /
          Node), three otherwise (the Library is reachable from any context,
          not just a connected session, so the Node tab is gated on the prop). */}
      <div className={`grid ${hasNode ? "grid-cols-4" : "grid-cols-3"} shrink-0 border-b border-white/5 bg-black/20`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`h-9 min-w-0 px-1 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-wider transition-all ${
              tab === t.id
                ? "text-primary bg-primary/5 border-b border-primary"
                : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03] border-b border-transparent"
            }`}
          >
            <t.icon size={12} className="shrink-0" /><span className="truncate">{t.label}</span>
            {t.badge}
          </button>
        ))}
      </div>

      {/* Search Input — only on list-shaped tabs; the Node tab is a single
          editor so search would have nothing to filter. */}
      {tab !== "node" && (
        <div className="p-3 shrink-0 border-b border-white/5 bg-black/20">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder={tab === "commands" ? "Search commands (title + body)..." : tab === "history" ? "Search history..." : "Search notes (title + body)..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 pl-9 pr-3 bg-white/5 border border-white/5 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50 focus:bg-white/10 transition-all"
            />
          </div>
          {tab === "history" && (
            <div className="mt-2 flex items-center gap-2">
              {hasNode && (
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={onlyThisServer}
                    onChange={(e) => setOnlyThisServer(e.target.checked)}
                  />
                  This server only
                </label>
              )}
              <span className="text-[10px] text-zinc-500 font-bold">{history.length}</span>
              <div className="flex-1" />
              <button
                onClick={() => void clearHistory(history.length)}
                // Off while searching: it clears every row in scope, not
                // just the matches on screen. And while the list is being
                // re-read (just after "This server only" flips), when the
                // count on screen is for the other scope.
                disabled={history.length === 0 || !!searchQuery || historyLoading}
                className="h-6 px-2 rounded-md bg-white/[0.03] border border-white/10 hover:bg-rose-500/15 hover:border-rose-500/40 text-zinc-400 hover:text-rose-300 flex items-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/[0.03] disabled:hover:border-white/10 disabled:hover:text-zinc-400"
                title={searchQuery ? "Clear the search first: Clear removes all history, not just the matches" : hasNode && onlyThisServer ? "Clear this server's history" : "Clear all history"}
              >
                <Trash2 size={11} /> Clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2 no-scrollbar">
        {listLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500 gap-2">
            <RefreshCw size={24} className="animate-spin text-primary opacity-60" />
            <span className="text-[11px]">Loading {tabLabel.toLowerCase()}...</span>
          </div>
        ) : tab === "node" ? (
          <div className="flex flex-col h-full gap-2">
            <div className="flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Server size={12} className="text-primary shrink-0" />
                <span className="text-[11px] font-bold text-zinc-200 truncate">{serverName || `Node #${serverId}`}</span>
              </div>
              <button
                onClick={() => copyToClipboard(nodeDraft || "")}
                disabled={!nodeDraft}
                className="h-7 px-2 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                title="Copy current draft to clipboard"
              >
                <ClipboardCopy size={11} /> Copy
              </button>
            </div>
            <textarea
              value={nodeDraft}
              onChange={(e) => setNodeDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void saveNodeNotes(); }
              }}
              placeholder={`Notes for this node — paths, credentials hints, runbook steps…\nSaved on tab switch or Ctrl+Enter.`}
              className="flex-1 w-full p-3 bg-black/40 border border-white/10 rounded-lg font-sans text-[12px] text-zinc-200 placeholder-zinc-600 leading-relaxed resize-none focus:outline-none focus:border-primary/50 custom-scrollbar"
            />
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => setNodeDraft(nodeOriginal)}
                disabled={nodeSaving || !isNodeDirty}
                className="flex-1 h-8 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                title="Revert to last saved version"
              >
                <X size={11} /> Revert
              </button>
              <button
                onClick={() => void saveNodeNotes()}
                disabled={nodeSaving || !isNodeDirty}
                className="flex-1 h-8 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                title="Save (Ctrl+Enter, auto-saves on tab switch)"
              >
                {nodeSaving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save
              </button>
            </div>
          </div>
        ) : tab === "history" ? (
          filteredHistory.length > 0 ? (
            filteredHistory.map((h) => {
              const form = adding?.id === h.id ? adding : null;
              const saved = savedContents.has(h.command);
              const menuOpen = historyMenu?.entry.id === h.id;
              return (
                <div
                  key={h.id}
                  onContextMenu={(e) => openHistoryMenu(e, h)}
                  className={`group relative rounded-lg border transition-all ${
                    menuOpen ? "bg-white/[0.06] border-white/15" : "border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10"
                  }`}
                >
                  <div className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-[11px] text-zinc-200 truncate group-hover:text-primary transition-colors" title={h.command}>
                        {h.command}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500 min-w-0">
                        <span className="shrink-0" title={new Date(h.ts).toLocaleString()}>{relTime(h.ts)} ago</span>
                        {!(hasNode && onlyThisServer) && h.server_name && (
                          <>
                            <span className="text-zinc-700">·</span>
                            <span className="truncate">{h.server_name}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => writeToTerminal(h.command, true)}
                        className="w-7 h-7 rounded-md bg-primary/15 text-primary border border-primary/40 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center transition-all"
                        title="Run in active terminal (writes + Enter)"
                      >
                        <Play size={12} fill="currentColor" />
                      </button>
                      <button
                        onClick={() => writeToTerminal(h.command, false)}
                        className="w-7 h-7 rounded-md bg-white/[0.03] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center transition-all"
                        title="Paste into active terminal (no Enter)"
                      >
                        <ClipboardCopy size={12} />
                      </button>
                      <button
                        onClick={() => (form ? setAdding(null) : beginAdd(h))}
                        disabled={saved}
                        className="w-7 h-7 rounded-md bg-white/[0.03] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center transition-all disabled:text-emerald-400 disabled:border-emerald-500/30 disabled:bg-emerald-500/10 disabled:cursor-default"
                        title={saved ? "Already in Commands" : "Add to Commands"}
                      >
                        {saved ? <Check size={12} /> : <BookmarkPlus size={12} />}
                      </button>
                    </div>
                  </div>
                  {form && (
                    <div className="px-3 pb-3 space-y-2">
                      <input
                        type="text"
                        value={form.title}
                        onChange={(e) => setAdding({ ...form, title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.preventDefault(); setAdding(null); }
                          // Not the Enter that picks an IME candidate.
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void saveAdd(); }
                        }}
                        placeholder="Title"
                        className="w-full h-7 px-2 bg-black/40 border border-white/10 rounded text-[11px] text-white placeholder-zinc-600 focus:outline-none focus:border-primary/50"
                        autoFocus
                      />
                      <textarea
                        value={form.body}
                        onChange={(e) => setAdding({ ...form, body: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.preventDefault(); setAdding(null); }
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void saveAdd(); }
                        }}
                        placeholder="Command body — runnable in shell"
                        rows={3}
                        className="w-full p-2 bg-black/40 border border-white/10 rounded font-mono text-[11px] text-zinc-200 placeholder-zinc-600 leading-relaxed resize-y focus:outline-none focus:border-primary/50 custom-scrollbar"
                      />
                      {canScopeToServer && (
                        <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-black/40 border border-white/10">
                          {(["server", "all"] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => setAdding({ ...form, scope: s })}
                              className={`h-6 rounded-md text-[10px] font-bold transition-all ${
                                form.scope === s ? "bg-primary/15 text-primary" : "text-zinc-500 hover:text-zinc-200"
                              }`}
                            >
                              {s === "server" ? "This server" : "All servers"}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => setAdding(null)}
                          disabled={saving}
                          className="flex-1 h-7 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-50"
                        >
                          <X size={11} /> Cancel
                        </button>
                        <button
                          onClick={() => void saveAdd()}
                          disabled={saving || !canSaveAdd(form)}
                          className="flex-1 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Save to Commands (Ctrl+Enter)"
                        >
                          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-600 text-center px-4">
              <History size={32} className="opacity-20 mb-2" />
              <span className="text-xs font-bold text-zinc-500">{searchQuery ? "No History Found" : "No History Yet"}</span>
              <p className="text-[10px] mt-1 text-zinc-600 max-w-[200px]">
                {searchQuery ? "No matches for your search query." : "Commands you run in a terminal will appear here."}
              </p>
            </div>
          )
        ) : tab === "commands" ? (
          filteredCommands.length > 0 ? (
            filteredCommands.map((c, i) => {
              const editing = edit?.kind === "command" && edit.id === c.id;
              const heading = headingAt(i);
              return (
                <Fragment key={c.id}>
                {heading && (
                  <div className="px-1 pt-1 text-[9.5px] font-bold uppercase tracking-widest text-zinc-500" data-command-group>
                    {heading}
                  </div>
                )}
                <div
                  className="group relative rounded-lg border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all"
                >
                  {editing ? (
                    <div className="p-3 space-y-2">
                      <input
                        type="text"
                        value={edit.title}
                        onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                        }}
                        placeholder="Title"
                        className="w-full h-7 px-2 bg-black/40 border border-white/10 rounded text-[11px] text-white placeholder-zinc-600 focus:outline-none focus:border-primary/50"
                        autoFocus
                      />
                      <textarea
                        value={edit.body}
                        onChange={(e) => setEdit({ ...edit, body: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); saveEdit(); }
                        }}
                        placeholder="Command body — runnable in shell"
                        rows={5}
                        className="w-full p-2 bg-black/40 border border-white/10 rounded font-mono text-[11px] text-zinc-200 placeholder-zinc-600 leading-relaxed resize-y focus:outline-none focus:border-primary/50 custom-scrollbar"
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={cancelEdit}
                          disabled={saving}
                          className="flex-1 h-7 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-50"
                        >
                          <X size={11} /> Cancel
                        </button>
                        <button
                          onClick={saveEdit}
                          disabled={saving || !isDirty(edit)}
                          className="flex-1 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Save (Ctrl+Enter)"
                        >
                          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h4 className="text-xs font-bold text-zinc-200 truncate group-hover:text-primary transition-colors">
                            {c.title}
                          </h4>
                          <pre
                            className="mt-1.5 p-1.5 px-2 bg-black/40 rounded border border-white/5 font-mono text-[10px] text-zinc-400 truncate whitespace-nowrap overflow-hidden"
                            title={c.content}
                          >
                            {c.content.split('\n')[0] || ""}{c.content.split('\n').length > 1 ? " ..." : ""}
                          </pre>
                        </div>
                      </div>
                      <div className="flex gap-1.5 mt-2">
                        <button
                          onClick={() => writeToTerminal(c.content, true)}
                          className="flex-1 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all"
                          title="Run in active terminal (writes + Enter)"
                        >
                          <Play size={11} fill="currentColor" /> Run
                        </button>
                        <button
                          onClick={() => writeToTerminal(c.content, false)}
                          className="flex-1 h-7 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all"
                          title="Paste into active terminal (no Enter)"
                        >
                          <ClipboardCopy size={11} /> Paste
                        </button>
                        <button
                          onClick={() => beginEditCommand(c)}
                          className="flex-1 h-7 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all"
                          title="Edit command inline"
                        >
                          <Pencil size={11} /> Edit
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-600 text-center px-4">
              <Terminal size={32} className="opacity-20 mb-2" />
              <span className="text-xs font-bold text-zinc-500">No Commands Found</span>
              <p className="text-[10px] mt-1 text-zinc-600 max-w-[200px]">
                {searchQuery ? "No matches for your search query." : "Save commands in the main app to surface them here."}
              </p>
            </div>
          )
        ) : filteredNotes.length > 0 ? (
          filteredNotes.map((n) => {
            const expanded = edit?.kind === "note" && edit.id === n.id;
            return (
              <div
                key={n.id}
                className="group relative rounded-lg border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all"
              >
                <button
                  onClick={() => {
                    if (expanded) {
                      // Click on row again → collapse + auto-save.
                      collapseEditedNote();
                    } else {
                      // Switching from one note to another also auto-saves.
                      flushIfDirty(editRef.current);
                      beginEditNote(n);
                    }
                  }}
                  className="w-full flex items-start gap-2 px-3 pt-3 pb-2 text-left"
                >
                  <span className="mt-0.5 text-zinc-500 group-hover:text-zinc-300 shrink-0">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-bold text-zinc-200 truncate group-hover:text-primary transition-colors">
                      {(expanded ? edit.title : n.title) || "Untitled"}
                    </h4>
                    {!expanded && (
                      <p className="mt-1 text-[10px] text-zinc-500 truncate">
                        {(n.body || "").split('\n')[0] || <span className="italic">(empty)</span>}
                      </p>
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="px-3 pb-3 space-y-2">
                    <input
                      type="text"
                      value={edit.title}
                      onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                      placeholder="Title"
                      className="w-full h-7 px-2 bg-black/40 border border-white/10 rounded text-[11px] text-white placeholder-zinc-600 focus:outline-none focus:border-primary/50"
                    />
                    <textarea
                      value={edit.body}
                      onChange={(e) => setEdit({ ...edit, body: e.target.value })}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); saveEdit(); }
                      }}
                      placeholder="Note body — markdown, paths, snippets…"
                      rows={6}
                      className="w-full p-2 bg-black/40 border border-white/10 rounded font-sans text-[11px] text-zinc-200 placeholder-zinc-600 leading-relaxed resize-y focus:outline-none focus:border-primary/50 custom-scrollbar"
                      autoFocus
                    />
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        onClick={() => copyToClipboard(edit.body || "")}
                        className="flex-1 h-7 min-w-[64px] rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all"
                        title="Copy current body to clipboard"
                      >
                        <ClipboardCopy size={11} /> Copy
                      </button>
                      <button
                        onClick={() => writeToTerminal(edit.body || "", false)}
                        className="flex-1 h-7 min-w-[64px] rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/10 hover:border-white/20 text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all"
                        title="Paste body into active terminal (no Enter)"
                      >
                        <Play size={11} fill="currentColor" /> Paste
                      </button>
                      <button
                        onClick={saveEdit}
                        disabled={saving || !isDirty(edit)}
                        className="flex-1 h-7 min-w-[64px] rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-zinc-950 hover:border-primary flex items-center justify-center gap-1.5 text-[10px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        title={isDirty(edit) ? "Save changes (Ctrl+Enter)" : "No unsaved changes"}
                      >
                        {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-600 text-center px-4">
            <StickyNote size={32} className="opacity-20 mb-2" />
            <span className="text-xs font-bold text-zinc-500">No Notes Found</span>
            <p className="text-[10px] mt-1 text-zinc-600 max-w-[200px]">
              {searchQuery ? "No matches for your search query." : "Add notes from the Notes tab to surface them here."}
            </p>
          </div>
        )}
      </div>

      {historyMenu && createPortal(
        <div
          ref={historyMenuRef}
          style={{ top: historyMenu.y, left: historyMenu.x }}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-[9999] min-w-[160px] bg-[#0c0c0e] border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11.5px] text-zinc-200"
        >
          <button
            onClick={() => void deleteHistoryEntry(historyMenu.entry)}
            className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-rose-950/20 text-left text-rose-400"
          >
            <Trash2 size={11} /><span>Delete</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};
