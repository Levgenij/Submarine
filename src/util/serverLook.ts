import { Terminal, Cable, Monitor, ScreenShare, FolderSync } from "lucide-react";
import type { CSSProperties } from "react";
import { USUAL_PORTS, serverProtocol } from "./serverProtocol";

// How a saved server looks in the Servers page (Cards and Tree): the icon of
// its kind of connection, its own colour, the dot of its open tab.

export const PROTOCOL_ICON: Record<string, typeof Terminal> = {
  ssh: Terminal, telnet: Cable, rdp: Monitor, vnc: ScreenShare,
  ftp: FolderSync, ftps: FolderSync, "ftps-implicit": FolderSync,
};
// The port each protocol uses by default: another one is shown after the host.
export const USUAL_PORT: Record<string, number> = USUAL_PORTS;
// A server with no (or an unknown) protocol is SSH.
export const protocolOf = (s: any): string => serverProtocol(s?.protocol);

// The host, and the port when it isn't the protocol's usual one.
export const hostPort = (s: any): string => {
  const host: string = s?.host ?? "";
  const port = Number(s?.port);
  if (!(port > 0) || port === USUAL_PORT[protocolOf(s)]) return host;
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
};

// The dot of a server whose tab is open, in the colours of the tab's own dot.
export const TAB_DOT: Record<string, string> = {
  waiting: "bg-primary animate-pulse-brief",
  connected: "bg-emerald-400",
  connecting: "bg-amber-400 animate-pulse-brief",
  failed: "bg-rose-500",
  disconnected: "bg-rose-500",
  idle: "bg-zinc-500",
};
export const TAB_TITLE: Record<string, string> = {
  waiting: "Waiting for you: open this tab to answer",
  connected: "Connected",
  connecting: "Connecting…",
  failed: "Connection failed",
  disconnected: "Disconnected",
  idle: "Idle",
};
// Any other status gets the neutral dot and a plain title, never the raw word.
export const tabDot = (st: string) => TAB_DOT[st] ?? "bg-zinc-500";
export const tabTitle = (st: string) => TAB_TITLE[st] ?? "Tab open";

export const hexRgb = (c?: string | null): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((c || "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
// The colour a server (or folder) is drawn in: its own, else the accent.
export const accentOf = (color?: string | null): string => (hexRgb(color) ? (color as string).trim() : "rgb(var(--primary))");

// A server's own colour as its avatar's fill, edge and glyph, the glyph a
// little lighter so it reads on the dark card; the accent without one.
export const avatarStyle = (color?: string | null): CSSProperties => {
  const rgb = hexRgb(color);
  if (!rgb) return { background: "rgb(var(--primary) / 0.16)", borderColor: "rgb(var(--primary) / 0.4)", color: "rgb(var(--primary))" };
  const [r, g, b] = rgb;
  const lift = (v: number) => Math.round(v + (255 - v) * 0.35);
  return { background: `rgba(${r}, ${g}, ${b}, 0.16)`, borderColor: `rgba(${r}, ${g}, ${b}, 0.4)`, color: `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})` };
};
