// Open-session snapshot: which saved servers were open, with which terminal
// tabs and custom names, so the next unlock can reopen them. Stored per
// profile in localStorage, which makes every read untrusted input: anything
// off-shape is dropped here, so callers can use the result as is.
export interface SnapTerm {
  title: string;
  container?: { name: string; useSudo: boolean };
}

export interface SnapSession {
  serverId: number;
  customName?: string;
  terminals: SnapTerm[];
  activeIndex: number;
}

export interface SessionSnapshot {
  version: 1;
  activeServerId: number | null;
  sessions: SnapSession[];
}

export const MAX_SNAP_SESSIONS = 20;
export const MAX_SNAP_TERMS = 10;
const MAX_LABEL = 60;

export const snapshotKey = (profile: string) => `submarine-open-sessions.v1.${profile}`;

const isServerId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const label = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_LABEL) : undefined;

// Quick-connect sessions (serverId 0) are left out: their credentials live
// only in memory, so there is nothing to re-dial.
export function buildSnapshot(opts: {
  sessions: { id: string; serverId: number; customName?: string }[];
  terminalsBySession: Record<string, { id: string; title: string; container?: { name: string; useSudo: boolean } }[]>;
  activeTermBySession: Record<string, string>;
  activeView: string;
}): SessionSnapshot {
  const saved = opts.sessions.filter((s) => isServerId(s.serverId)).slice(0, MAX_SNAP_SESSIONS);
  return {
    version: 1,
    activeServerId: saved.find((s) => s.id === opts.activeView)?.serverId ?? null,
    sessions: saved.map((s) => {
      const terms = (opts.terminalsBySession[s.id] ?? []).slice(0, MAX_SNAP_TERMS);
      return {
        serverId: s.serverId,
        ...(s.customName ? { customName: s.customName } : {}),
        terminals: terms.length > 0
          ? terms.map((t) => ({ title: t.title, ...(t.container ? { container: { name: t.container.name, useSudo: t.container.useSudo } } : {}) }))
          : [{ title: "1" }],
        activeIndex: Math.max(0, terms.findIndex((t) => t.id === opts.activeTermBySession[s.id])),
      };
    }),
  };
}

function parseTerm(raw: any, index: number): SnapTerm {
  const title = label(raw?.title) ?? String(index + 1);
  const name = raw?.container?.name;
  return typeof name === "string" && name
    ? { title, container: { name, useSudo: raw.container.useSudo === true } }
    : { title };
}

export function parseSnapshot(raw: string | null, hasServer: (id: number) => boolean): {
  sessions: SnapSession[];
  activeServerId: number | null;
} {
  let snap: any = null;
  try {
    snap = raw ? JSON.parse(raw) : null;
  } catch {
    snap = null;
  }
  if (!Array.isArray(snap?.sessions)) return { sessions: [], activeServerId: null };

  const seen = new Set<number>();
  const sessions: SnapSession[] = [];
  for (const r of snap.sessions) {
    if (sessions.length >= MAX_SNAP_SESSIONS) break;
    if (!isServerId(r?.serverId) || seen.has(r.serverId) || !hasServer(r.serverId)) continue;
    seen.add(r.serverId);
    const terms: SnapTerm[] = (Array.isArray(r.terminals) ? r.terminals.slice(0, MAX_SNAP_TERMS) : []).map(parseTerm);
    const terminals = terms.length > 0 ? terms : [{ title: "1" }];
    const index = Number.isInteger(r.activeIndex) ? r.activeIndex : 0;
    const customName = label(r.customName);
    sessions.push({
      serverId: r.serverId,
      ...(customName ? { customName } : {}),
      terminals,
      activeIndex: Math.min(Math.max(0, index), terminals.length - 1),
    });
  }
  const active = snap.activeServerId;
  return { sessions, activeServerId: seen.has(active) ? active : null };
}
