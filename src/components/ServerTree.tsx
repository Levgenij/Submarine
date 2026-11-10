import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ArrowUp, ArrowDown, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder, GripVertical, House, MoreHorizontal, Server } from "lucide-react";
import type { FolderTree } from "../util/folderTree";
import { placeAt, sortFolders, sortServers, relativeTime, type SortDir, type SortKey } from "../util/serverOrder";
import { useStoredList } from "../util/storedJson";

// The Tree view of the server list: every folder and server in one tree grid
// (WAI-ARIA treegrid, one Tab stop, arrows move between rows). Folders come
// first at each level; servers outside any folder sit under "Ungrouped".
// Rows drag by their grip: a server between servers (manual order) or into a
// folder, a folder into another folder or up to the top level.
// With `mixed`, each level is one list of folders and servers sorted
// together, as in Cards, and top-level servers sit among the top folders.

type Row =
  | { key: string; kind: "folder"; f: any; level: number; parent: string | null; trail: boolean[]; last: boolean; open: boolean }
  | { key: string; kind: "server"; s: any; level: number; parent: string | null; trail: boolean[]; last: boolean }
  | { key: string; kind: "draft"; level: number; parent: string | null; trail: boolean[]; last: boolean }
  | { key: string; kind: "ungrouped"; open: boolean; count: number };

const INDENT = 24;
// Room on the left for the drag grip.
const PAD = 26;
// x of the guide line in column `i` (under the chevron of the level-`i+1` folder).
const guideX = (i: number) => PAD + i * INDENT + 10;

// Every row is its own grid, so the columns line up only with fixed tracks: no `auto`.
const COLS = "grid grid-cols-[minmax(0,1fr)_76px] sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1fr)_76px]";

// atPointer: opened by a right click, so it hangs right of the pointer; else under the ⋯ button, right-aligned to it.
type Menu = { row: Row; x: number; y: number; atPointer: boolean; returnTo: HTMLElement | null };

type Dragged = { kind: "server" | "folder"; item: any };
// Where a drag would land: into folder `into` (null: the top level), and with
// `id`, before or after that server there (a place in the manual order).
type Drop = { into: number | null; key: string; id?: number; before?: boolean };
const sameDrop = (a: Drop | null, b: Drop | null) =>
  a === b || (!!a && !!b && a.key === b.key && a.into === b.into && a.id === b.id && a.before === b.before);

export function ServerTree(props: {
  servers: any[];           // the servers to show: already filtered by the search
  allServers: any[];        // for the folder counts
  mixed: boolean;
  tree: FolderTree;
  isSearching: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  lastSeen: Record<string, number>;
  profile: string | null | undefined;
  isMobile?: boolean;
  onOpenServer: (s: any) => void;
  onEditServer: (s: any) => void;
  onCloneServer?: (id: number) => void;
  onAddClick: (folderId?: number | null) => void;
  askRemoveServer: (s: any) => void;
  askRemoveFolder: (f: any) => void;
  canCreateFolder: boolean;
  newFolder: { parent: number | null; name: string } | null;
  startNewFolder: (parent: number | null) => void;
  newFolderControls: () => ReactNode;
  canRename: boolean;
  renamingId: number | null;
  startRename: (f: any) => void;
  renameControls: () => ReactNode;
  onMoveServer?: (id: number, folderId: number | null) => Promise<void> | void;
  onMoveFolder?: (id: number, parentId: number | null) => Promise<void> | void;
  onReorderServers?: (ids: number[]) => Promise<void> | void;
}) {
  const { servers, allServers, tree, isSearching, sort, dir, lastSeen, newFolder, mixed } = props;
  const [openList, setOpenList] = useStoredList(`submarine-tree-expanded:${props.profile ?? ""}`, "submarine-tree-expanded");
  const [ungroupedOpen, setUngroupedOpen] = useState(true);

  // Servers per folder (null: none), each list in the chosen order.
  const byFolder = useMemo(() => {
    const m = new Map<number | null, any[]>();
    for (const s of servers) {
      const f = tree.serverFolder(s);
      if (!m.has(f)) m.set(f, []);
      m.get(f)!.push(s);
    }
    for (const [k, list] of m) m.set(k, sortServers(list, sort, dir, lastSeen));
    return m;
  }, [servers, tree, sort, dir, lastSeen]);

  // How many servers each folder holds, its subfolders included.
  const total = useMemo(() => {
    const direct = new Map<number, number>();
    for (const s of allServers) {
      const f = tree.serverFolder(s);
      if (f !== null) direct.set(f, (direct.get(f) ?? 0) + 1);
    }
    return (id: number) => { let n = 0; for (const f of tree.subtreeOf(id)) n += direct.get(f) ?? 0; return n; };
  }, [allServers, tree]);

  // While searching: only the folders on the way to a match, all open.
  const onPath = useMemo(() => {
    if (!isSearching) return null;
    const keep = new Set<number>();
    for (const f of byFolder.keys()) if (f !== null) for (const p of tree.pathOf(f)) keep.add(p.id);
    return keep;
  }, [isSearching, byFolder, tree]);

  const openSet = useMemo(() => new Set(openList), [openList]);
  const isOpen = (id: number) => (onPath ? onPath.has(id) : openSet.has(String(id)));
  // Through a ref: a drop calls this after awaits, when the render it came from is stale.
  const openListRef = useRef(openList);
  openListRef.current = openList;
  const setOpen = (id: number, open: boolean) => {
    const list = openListRef.current;
    if (onPath || list.includes(String(id)) === open) return;
    setOpenList(open ? [...list, String(id)] : list.filter((x) => x !== String(id)));
  };

  // Not while searching: the rows shown aren't the whole order.
  const canReorder = !!props.onReorderServers && sort === "manual" && !isSearching;
  const canDragServer = !isSearching && (!!props.onMoveServer || canReorder);
  const canDragFolder = !isSearching && !!props.onMoveFolder;
  const [drag, setDrag] = useState<Dragged | null>(null);
  const [drop, setDropState] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const setDrop = (d: Drop | null) => {
    if (sameDrop(dropRef.current, d)) return;
    dropRef.current = d;
    setDropState(d);
  };
  // True once a drag moves, so the click that ends it doesn't toggle a row.
  const draggedRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef({ x: 0, y: 0 });

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parentId: number | null, level: number, trail: boolean[]) => {
      const folders = sortFolders(tree.childrenOf(parentId), sort, dir).filter((f) => !onPath || onPath.has(f.id));
      // Grouped, top-level servers go under "Ungrouped", not here.
      const own = parentId === null && !mixed ? [] : byFolder.get(parentId) ?? [];
      const items = [
        ...folders.map((f) => ({ f, s: null as any, name: f.name, uuid: f.uuid })),
        ...own.map((s) => ({ f: null as any, s, name: s.name, host: s.host, uuid: s.uuid })),
      ];
      const draft = !isSearching && newFolder && newFolder.parent === parentId;
      const n = (draft ? 1 : 0) + items.length;
      let i = 0;
      const parent = parentId === null ? null : `f:${parentId}`;
      if (draft) out.push({ key: "draft", kind: "draft", level, parent, trail, last: ++i === n });
      for (const it of mixed ? sortServers(items, sort, dir, lastSeen) : items) {
        const last = ++i === n;
        if (it.s) { out.push({ key: `s:${it.s.id}`, kind: "server", s: it.s, level, parent, trail, last }); continue; }
        const open = isOpen(it.f.id);
        out.push({ key: `f:${it.f.id}`, kind: "folder", f: it.f, level, parent, trail, last, open });
        if (open) walk(it.f.id, level + 1, level === 1 ? [] : [...trail, !last]);
      }
    };
    walk(null, 1, []);
    const loose = mixed ? [] : byFolder.get(null) ?? [];
    if (!mixed && (loose.length || drag?.kind === "server")) {
      out.push({ key: "ungrouped", kind: "ungrouped", open: ungroupedOpen, count: loose.length });
      if (ungroupedOpen) for (const s of loose) out.push({ key: `s:${s.id}`, kind: "server", s, level: 1, parent: "ungrouped", trail: [], last: false });
    }
    return out;
  }, [tree, sort, dir, onPath, byFolder, openSet, newFolder, isSearching, ungroupedOpen, drag, mixed, lastSeen]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // A drop is allowed only where it changes something.
  const allowed = (t: Drop, d: Dragged) => {
    if (d.kind === "folder") {
      if (t.id !== undefined) return false;
      const from = tree.parentOf(d.item.id);
      return t.into === null ? from !== null : t.into !== from && !tree.subtreeOf(d.item.id).has(t.into);
    }
    if (t.into !== tree.serverFolder(d.item)) return !!props.onMoveServer;
    return t.id !== undefined && t.id !== d.item.id && canReorder;
  };
  const targetAt = (x: number, y: number, d: Dragged): Drop | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-row-key],[data-drop-root]");
    if (!el) return null;
    let t: Drop | null = null;
    if (el.dataset.dropRoot !== undefined) t = { into: null, key: "root" };
    else {
      const r = rowsRef.current.find((k) => k.key === el.dataset.rowKey);
      if (r?.kind === "folder") t = { into: r.f.id, key: r.key };
      else if (r?.kind === "ungrouped") t = { into: null, key: r.key };
      else if (r?.kind === "server" && d.kind === "server") {
        const box = el.getBoundingClientRect();
        t = { into: tree.serverFolder(r.s), key: r.key, id: r.s.id, before: y < box.top + box.height / 2 };
      }
    }
    return t && allowed(t, d) ? t : null;
  };
  const commitDrop = async (d: Dragged, t: Drop) => {
    try {
      if (d.kind === "folder") {
        await props.onMoveFolder?.(d.item.id, t.into);
      } else {
        const s = d.item;
        if (t.into !== tree.serverFolder(s)) await props.onMoveServer?.(s.id, t.into);
        if (t.id !== undefined && canReorder) {
          // The manual order of the target folder, with the server put in its new place.
          const ids = allServers.filter((x) => tree.serverFolder(x) === t.into).map((x) => x.id);
          await props.onReorderServers?.(placeAt(ids, s.id, t.id, !!t.before));
        }
      }
      // Show where it went.
      if (t.into !== null) setOpen(t.into, true);
      else if (d.kind === "server") setUngroupedOpen(true);
    } catch { /* the parent logs it; the tree shows what was stored */ }
  };
  const beginDrag = (e: ReactPointerEvent, d: Dragged) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    setMenu(null);
    setDrag(d);
  };
  useEffect(() => {
    if (!drag) return;
    const scroller = bodyRef.current?.closest<HTMLElement>(".custom-scrollbar") ?? null;
    document.body.style.userSelect = "none";
    const move = (e: PointerEvent) => {
      draggedRef.current = true;
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
      setDrop(targetAt(e.clientX, e.clientY, drag));
      // shortcut: scrolls only while the pointer moves near an edge; add a timer if holding still there should scroll too.
      if (scroller) {
        const b = scroller.getBoundingClientRect();
        if (e.clientY < b.top + 48) scroller.scrollBy(0, -18);
        else if (e.clientY > b.bottom - 48) scroller.scrollBy(0, 18);
      }
    };
    const end = (commit: boolean) => {
      const t = dropRef.current;
      setDrop(null);
      setDrag(null);
      setTimeout(() => { draggedRef.current = false; }, 0);
      if (commit && t) void commitDrop(drag, t);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); end(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.body.style.userSelect = "";
    };
  }, [drag]);
  // Holding a server or folder over a closed folder opens it, to drop deeper.
  useEffect(() => {
    const t = dropRef.current;
    if (!t || t.id !== undefined || t.into === null || !t.key.startsWith("f:") || isOpen(t.into)) return;
    const id = t.into;
    const timer = setTimeout(() => setOpen(id, true), 700);
    return () => clearTimeout(timer);
  }, [drop?.key]);

  const [menu, setMenu] = useState<Menu | null>(null);

  // Roving focus: the row with tabIndex 0. Follows the pointer and the arrows.
  const [current, setCurrent] = useState<string | null>(null);
  const focusKey = rows.some((r) => r.key === current) ? current : rows[0]?.key ?? null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowEl = (key: string) => bodyRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"]`) ?? null;
  const focusRow = (key: string | undefined) => { if (key) rowEl(key)?.focus(); };

  const toggle = (r: Row) => {
    if (r.kind === "folder") setOpen(r.f.id, !r.open);
    else if (r.kind === "ungrouped") setUngroupedOpen(!r.open);
  };

  const openMenuAt = (row: Row, x: number, y: number, atPointer = false) =>
    setMenu({ row, x, y, atPointer, returnTo: rowEl(row.key) });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const i = rows.findIndex((r) => r.key === focusKey);
    const r = rows[i];
    if (!r) return;
    const go = (k: string | undefined) => { e.preventDefault(); focusRow(k); };
    switch (e.key) {
      case "ArrowDown": return go(rows[i + 1]?.key);
      case "ArrowUp": return go(rows[i - 1]?.key);
      case "Home": return go(rows[0]?.key);
      case "End": return go(rows[rows.length - 1]?.key);
      case "ArrowRight":
        if ((r.kind === "folder" || r.kind === "ungrouped") && !r.open) { e.preventDefault(); toggle(r); }
        else if (r.kind === "folder" || r.kind === "ungrouped") go(rows[i + 1]?.key);
        return;
      case "ArrowLeft":
        if ((r.kind === "folder" || r.kind === "ungrouped") && r.open) { e.preventDefault(); toggle(r); }
        else if (r.kind !== "ungrouped" && r.parent) go(r.parent);
        return;
      case "Enter":
        e.preventDefault();
        if (r.kind === "server") props.onOpenServer(r.s); else toggle(r);
        return;
      case "F2":
        if (r.kind === "folder" && props.canRename) { e.preventDefault(); props.startRename(r.f); }
        return;
      case "Delete":
        if (r.kind === "folder") { e.preventDefault(); props.askRemoveFolder(r.f); }
        else if (r.kind === "server") { e.preventDefault(); props.askRemoveServer(r.s); }
        return;
    }
  };

  // Folder rows open and shut on a click; a server row is selected by a click
  // and connects on a double click, Enter or its arrow (one tap on touch).
  const onRowClick = (r: Row) => {
    if (draggedRef.current) return;
    setCurrent(r.key);
    if (r.kind === "server") { if (props.isMobile) props.onOpenServer(r.s); }
    else if (r.kind !== "draft") toggle(r);
  };

  const allFolders = useMemo(() => collectIds(tree), [tree]);
  const anyOpen = rows.some((r) => r.kind === "folder" && r.open);
  const expandAll = () => setOpenList([...allFolders].map(String));
  // Right click, long press, Shift+F10 and the Menu key all arrive as this.
  const onContextMenu = (r: Row) => (e: ReactMouseEvent) => {
    e.preventDefault();
    setCurrent(r.key);
    openMenuAt(r, e.clientX, e.clientY, true);
  };

  const header = (key: SortKey, label: string, className = "") => {
    const active = sort === key;
    const Arrow = dir === "desc" ? ArrowDown : ArrowUp;
    return (
      <div role="columnheader" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
        <button
          type="button"
          onClick={() => props.onSort(key)}
          title={active ? "Reverse the order" : `Sort by ${label.toLowerCase()}`}
          className={`inline-flex items-center gap-1.5 h-7 px-1.5 -mx-1.5 rounded text-[11px] font-semibold uppercase tracking-wider transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${active ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          {label}
          {active && <Arrow size={12} className="text-primary" />}
        </button>
      </div>
    );
  };

  const guides = (r: Extract<Row, { trail: boolean[] }>) => {
    if (r.level < 2) return null;
    const x = guideX(r.level - 2);
    const toIcon = r.kind === "folder" ? INDENT - 10 : INDENT - 10 + 20;
    return (
      <>
        {r.trail.map((on, i) => on && (
          <span key={i} aria-hidden className="absolute top-0 bottom-0 border-l border-white/10" style={{ left: guideX(i) }} />
        ))}
        <span aria-hidden className={`absolute top-0 border-l border-white/10 ${r.last ? "h-1/2" : "bottom-0"}`} style={{ left: x }} />
        <span aria-hidden className="absolute top-1/2 h-px bg-white/10" style={{ left: x, width: toIcon - 4 }} />
      </>
    );
  };

  const menuButton = (r: Row, name: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`More actions for ${name}`}
      aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); setCurrent(r.key); openMenuAt(r, b.right, b.bottom); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-white/5 transition-colors"
    >
      <MoreHorizontal size={16} />
    </button>
  );

  const isDragged = (r: Row) =>
    !!drag && ((r.kind === "server" && drag.kind === "server" && r.s.id === drag.item.id)
      || (r.kind === "folder" && drag.kind === "folder" && r.f.id === drag.item.id));
  const rowClass = (r: Row) => {
    const into = drop?.key === r.key && drop.id === undefined;
    return `${COLS} group relative items-center min-h-10 border-b border-white/[0.04] outline-none cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 ${
      into ? "bg-primary/15 ring-2 ring-inset ring-primary/70"
        : r.key === current ? "bg-primary/[0.07]" : drag ? "" : "hover:bg-white/[0.025]"
    } ${isDragged(r) ? "opacity-40" : ""}`;
  };
  // The line showing where a dragged server lands in the manual order.
  const dropLine = (r: Row, left: number) =>
    drop?.key === r.key && drop.id !== undefined && (
      <span aria-hidden className={`absolute right-2 h-0.5 rounded-full bg-primary z-[2] ${drop.before ? "-top-px" : "-bottom-px"}`} style={{ left }}>
        <span className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full border-2 border-primary bg-[#0f0f13]" />
      </span>
    );
  const grip = (d: Dragged) => {
    if (!(d.kind === "server" ? canDragServer : canDragFolder)) return null;
    return (
      <button
        type="button"
        tabIndex={-1}
        title={d.kind === "folder" ? "Drag into another folder" : canReorder ? "Drag to reorder, or into a folder" : "Drag into a folder"}
        onPointerDown={(e) => beginDrag(e, d)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="absolute left-1 top-1/2 -translate-y-1/2 z-[1] p-0.5 rounded text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-100 sm:opacity-0 sm:group-hover:opacity-100 [@media(hover:none)]:!opacity-100 transition-opacity"
        style={{ touchAction: "none" }}
      >
        <GripVertical size={14} />
      </button>
    );
  };

  const renderRow = (r: Row) => {
    const common = {
      "data-row-key": r.key,
      role: "row",
      tabIndex: r.key === focusKey ? 0 : -1,
      onFocus: () => setCurrent(r.key),
      onClick: () => onRowClick(r),
    };

    if (r.kind === "ungrouped") {
      return (
        <div key={r.key} {...common} aria-expanded={r.open} aria-level={1} className={`${rowClass(r)} bg-white/[0.02]`}>
          <div role="gridcell" className="col-span-full flex items-center gap-1.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400" style={{ paddingLeft: PAD }}>
            <ChevronDown size={13} className={`transition-transform ${r.open ? "" : "-rotate-90"}`} />
            Ungrouped <span className="text-zinc-600">·</span> <span className="text-zinc-500">{r.count}</span>
            {drag?.kind === "server" && <span className="ml-2 normal-case tracking-normal font-normal text-zinc-500">Drop here to take it out of its folder</span>}
          </div>
        </div>
      );
    }

    const pad = PAD + (r.level - 1) * INDENT;

    if (r.kind === "draft") {
      return (
        <div key={r.key} {...common} onClick={undefined} aria-level={r.level} className={`${COLS} relative items-center min-h-10 border-b border-white/[0.04] bg-primary/[0.04]`}>
          {guides(r)}
          <div role="gridcell" className="col-span-full flex items-center gap-2 py-1 pr-2" style={{ paddingLeft: pad + 20 }}>
            {props.newFolderControls()}
          </div>
        </div>
      );
    }

    if (r.kind === "folder") {
      const f = r.f;
      const n = total(f.id);
      const renaming = props.renamingId === f.id;
      return (
        <div key={r.key} {...common} aria-level={r.level} aria-expanded={r.open} aria-selected={r.key === current}
          onContextMenu={onContextMenu(r)}
          className={rowClass(r)}
        >
          {guides(r)}
          {!renaming && grip({ kind: "folder", item: f })}
          <div role="gridcell" className="min-w-0 flex items-center gap-2 py-1.5 pr-2" style={{ paddingLeft: pad }}>
            <ChevronRight size={15} className={`shrink-0 w-5 text-zinc-500 transition-transform duration-150 ${r.open ? "rotate-90" : ""}`} />
            <Folder size={18} className={`shrink-0 ${f.color ? "" : "text-primary"}`} style={{ color: f.color || undefined }} />
            {renaming ? (
              <div className="flex-1 min-w-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>{props.renameControls()}</div>
            ) : (
              <span className="min-w-0 flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-zinc-100">{f.name}</span>
                <span className="shrink-0 text-[11.5px] text-zinc-500">{n === 1 ? "1 server" : `${n} servers`}</span>
              </span>
            )}
          </div>
          <div role="gridcell" aria-hidden className="hidden sm:block text-zinc-600">—</div>
          <div role="gridcell" aria-hidden className="hidden sm:block text-zinc-600">—</div>
          <div role="gridcell" className="flex items-center justify-end gap-0.5 pr-2">
            {!renaming && menuButton(r, f.name)}
          </div>
        </div>
      );
    }

    const s = r.s;
    const seen = s.uuid ? lastSeen[s.uuid] : undefined;
    return (
      <div key={r.key} {...common} aria-level={r.level} aria-selected={r.key === current}
        onDoubleClick={() => props.onOpenServer(s)}
        onContextMenu={onContextMenu(r)}
        className={rowClass(r)}
      >
        {guides(r)}
        {grip({ kind: "server", item: s })}
        {dropLine(r, pad + (r.parent === "ungrouped" ? 0 : 20))}
        {/* The icon lines up with the folder icons beside it (past their chevron). */}
        <div role="gridcell" className="min-w-0 flex items-center gap-2 py-1.5 pr-2" style={{ paddingLeft: pad + (r.parent === "ungrouped" ? 0 : 20) }}>
          <Server size={18} className={`shrink-0 ${s.color ? "" : "text-primary"}`} style={{ color: s.color || undefined }} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-[13px] text-zinc-100">{s.name}</span>
              {protocolTag(s)}
            </span>
            <span className="sm:hidden block truncate text-[11px] text-zinc-400 font-mono">{s.host}</span>
          </span>
        </div>
        <div role="gridcell" className="hidden sm:block min-w-0 truncate pr-3 font-mono text-[12px] text-zinc-300">{s.host}</div>
        <div role="gridcell" className="hidden sm:block min-w-0 truncate pr-3 text-[12px] text-zinc-400" title={seen ? new Date(seen).toLocaleString() : undefined}>
          {/* shortcut: re-rendered on any change only, not ticking each minute; add a timer if stale labels bother anyone. */}
          {relativeTime(seen)}
        </div>
        <div role="gridcell" className="flex items-center justify-end gap-0.5 pr-2">
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Connect to ${s.name}`}
            title="Connect"
            onClick={(e) => { e.stopPropagation(); props.onOpenServer(s); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="p-1.5 rounded-md text-zinc-400 hover:text-primary hover:bg-primary/10 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100 sm:group-aria-selected:opacity-100 [@media(hover:none)]:!opacity-100"
          >
            <ArrowRight size={16} />
          </button>
          {menuButton(r, s.name)}
        </div>
      </div>
    );
  };

  return (
    <div className="pb-2">
      <div className="flex items-center justify-between gap-3 mb-2 px-1">
        {/* Also where a folder or server is dropped to go to the top level. */}
        <div
          data-drop-root
          className={`flex items-center gap-2 h-8 px-2 -ml-2 rounded-lg text-[13px] min-w-0 transition-colors ${
            drop?.key === "root" ? "bg-primary/15 ring-2 ring-primary/70 text-primary" : drag ? "outline-dashed outline-1 outline-white/20 text-zinc-300" : "text-zinc-300"
          }`}
        >
          <House size={15} className="shrink-0 opacity-80" />
          <span className="text-zinc-600">/</span>
          <span className="truncate">{isSearching ? "Search results" : drag ? "All servers: drop here for the top level" : "All servers"}</span>
        </div>
        {!isSearching && allFolders.size > 0 && (
          <button
            type="button"
            onClick={() => (anyOpen ? setOpenList([]) : expandAll())}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      <div role="treegrid" aria-label="Servers and folders" className="rounded-xl border border-white/[0.07] bg-[#0f0f13] overflow-hidden">
        <div role="rowgroup" className="sticky top-0 z-10 bg-[#121217] border-b border-white/[0.07]">
          <div role="row" className={`${COLS} items-center h-9`}>
            {header("name", "Name", "pl-3")}
            {header("host", "Host", "hidden sm:block")}
            {header("recent", "Last connected", "hidden sm:block")}
            <div role="columnheader" className="w-[76px]"><span className="sr-only">Actions</span></div>
          </div>
        </div>
        <div role="rowgroup" ref={bodyRef} onKeyDown={onKeyDown}>
          {rows.map(renderRow)}
          {rows.length === 0 && (
            <div className="py-10 text-center text-zinc-600 text-xs italic">{isSearching ? "No matches." : "Nothing here yet."}</div>
          )}
        </div>
      </div>

      {!props.isMobile && rows.length > 0 && (
        <p className="mt-2 px-1 text-[11px] text-zinc-600">
          ↑↓ move · → ← open and close · Enter connect · F2 rename · Shift+F10 more actions{(canDragServer || canDragFolder) && " · drag ⋮⋮ to move"}
        </p>
      )}

      {drag && createPortal(
        <div
          ref={ghostRef}
          className={`fixed left-0 top-0 z-[9999] pointer-events-none flex items-center gap-2 h-8 px-3 rounded-lg bg-[#1b1b20] border shadow-2xl shadow-black/60 text-[12.5px] text-zinc-100 will-change-transform ${drop ? "border-primary/60" : "border-white/15 opacity-80"}`}
          style={{ transform: `translate(${startRef.current.x + 14}px, ${startRef.current.y + 12}px)` }}
        >
          {drag.kind === "folder" ? <Folder size={15} className="text-primary shrink-0" /> : <Server size={15} className="text-primary shrink-0" />}
          <span className="max-w-[220px] truncate">{drag.item.name}</span>
          {drop && !(drop.id !== undefined && drop.into === tree.serverFolder(drag.item)) && (
            <span className="text-primary/90 truncate max-w-[200px]">→ {drop.into === null ? "Top level" : tree.pathOf(drop.into).at(-1)?.name}</span>
          )}
        </div>,
        document.body,
      )}

      {menu && (
        <RowMenu
          menu={menu}
          onClose={() => { const back = menu.returnTo; setMenu(null); back?.focus(); }}
          items={menu.row.kind === "server"
            ? [
                { label: "Connect", run: () => props.onOpenServer((menu.row as any).s) },
                { label: "Edit", run: () => props.onEditServer((menu.row as any).s) },
                ...(props.onCloneServer ? [{ label: "Clone", run: () => props.onCloneServer!((menu.row as any).s.id) }] : []),
                { label: "Delete", danger: true, run: () => props.askRemoveServer((menu.row as any).s) },
              ]
            : menu.row.kind === "folder"
              ? (() => {
                  const f = (menu.row as any).f;
                  return [
                    { label: "Add server here", run: () => props.onAddClick(f.id) },
                    ...(props.canCreateFolder ? [{ label: "New subfolder", run: () => { setOpen(f.id, true); props.startNewFolder(f.id); } }] : []),
                    ...(props.canRename ? [{ label: "Rename", run: () => props.startRename(f) }] : []),
                    { label: "Delete", danger: true, run: () => props.askRemoveFolder(f) },
                  ];
                })()
              : []}
        />
      )}
    </div>
  );
}

function collectIds(tree: FolderTree): Set<number> {
  const out = new Set<number>();
  const add = (p: number | null) => { for (const f of tree.childrenOf(p)) { out.add(f.id); add(f.id); } };
  add(null);
  return out;
}

/** The RDP / TELNET / VNC tag of a server; null for SSH, the default. */
export function protocolTag(s: any) {
  const tag =
    s.protocol === "rdp" ? { t: "RDP", c: "text-sky-300 bg-sky-500/10 border-sky-500/20", title: "RDP server" } :
    s.protocol === "telnet" ? { t: "TELNET", c: "text-amber-300 bg-amber-500/10 border-amber-500/20", title: "Telnet server (not encrypted)" } :
    s.protocol === "vnc" ? {
      t: "VNC", c: "text-violet-300 bg-violet-500/10 border-violet-500/20",
      title: s.jump_host_id ? "Only the hop after the SSH server isn't encrypted" : "VNC server (not encrypted)",
    } :
    null;
  return tag && <span title={tag.title} className={`shrink-0 px-1 rounded text-[9px] font-bold tracking-wider leading-[14px] border ${tag.c}`}>{tag.t}</span>;
}

// The ⋯ menu of a row: a small popup at the pointer or under the button,
// kept on screen. Arrows move, Enter runs, Escape or a click outside closes.
function RowMenu({ menu, items, onClose }: {
  menu: Menu;
  items: { label: string; danger?: boolean; run: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.atPointer ? menu.x : menu.x - width, window.innerWidth - width - 8))}px`;
    el.style.top = `${menu.y + height + 8 > window.innerHeight ? Math.max(8, menu.y - height - (menu.atPointer ? 4 : 36)) : menu.y + 4}px`;
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const away = () => onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("resize", away);
    window.addEventListener("wheel", away, { passive: true });
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("resize", away);
      window.removeEventListener("wheel", away);
    };
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      className="fixed z-[9999] min-w-[180px] p-1 rounded-lg bg-[#161619] border border-white/10 shadow-2xl shadow-black/60 text-[12.5px]"
      style={{ left: menu.x, top: menu.y }}
    >
      {items.map((it, i) => (
        <div key={it.label}>
          {it.danger && i > 0 && <div role="separator" className="my-1 h-px bg-white/5" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => { onClose(); it.run(); }}
            className={`w-full text-left px-2.5 py-1.5 rounded-md outline-none transition-colors ${
              it.danger ? "text-red-400 hover:bg-red-500/10 focus:bg-red-500/10" : "text-zinc-200 hover:bg-white/5 focus:bg-white/5"
            }`}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
