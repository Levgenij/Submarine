// "Push shell config": which of this device's files go where on a server
// (local/remote pairs), and which saved servers offer the push. Both are this
// device's own settings (localStorage), like the font prefs in
// terminalFont.ts: they're about THIS machine's files, so they stay out of
// the vault and aren't synced.
//
// `remote` is a place below the remote account's home folder (".zshrc",
// "~/.config/fish") rather than a full path, so that one list works on
// servers with different user names. Servers are kept by their sync id
// (`uuid`), which no other profile's server shares.
import { useEffect, useState } from "react";
import { readStoredJson, stringsOf, writeStoredJson } from "./storedJson";

export const SHELL_SYNC_PAIRS_KEY = "submarine-shell-sync-pairs";
export const SHELL_SYNC_SERVERS_KEY = "submarine-shell-sync-servers";
// Sent when either changes, so that an open session's button follows Settings.
const CHANGED = "submarine-shell-sync-changed";

export interface ShellSyncPair {
  local: string;
  remote: string;
}

export function readShellSyncPairs(): ShellSyncPair[] {
  const parsed = readStoredJson(SHELL_SYNC_PAIRS_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((p): p is ShellSyncPair => p && typeof p.local === "string" && typeof p.remote === "string")
    .map((p) => ({ local: p.local, remote: p.remote }));
}

// Best-effort, same as the other per-device prefs.
export function writeShellSyncPairs(pairs: ShellSyncPair[]): void {
  writeStoredJson(SHELL_SYNC_PAIRS_KEY, pairs, CHANGED);
}

/** The sync ids of the servers that offer the push. */
export function readShellSyncServers(): string[] {
  return stringsOf(readStoredJson(SHELL_SYNC_SERVERS_KEY));
}

export function setShellSyncServer(uuid: string, on: boolean): void {
  const rest = readShellSyncServers().filter((u) => u !== uuid);
  writeStoredJson(SHELL_SYNC_SERVERS_KEY, on ? [...rest, uuid] : rest, CHANGED);
}

/** Whether the server with this sync id offers the push, following Settings. */
export function useShellSyncServer(uuid: string | null | undefined): boolean {
  const read = () => !!uuid && readShellSyncServers().includes(uuid);
  const [on, setOn] = useState(read);
  useEffect(() => {
    const update = () => setOn(read());
    update();
    window.addEventListener(CHANGED, update);
    // Another window of the app shares the storage.
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);
  return on;
}

// The backend's checks on a pair, early, for a hint in Settings. The backend
// checks again before anything is read or sent.

const isFullPath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

export function localPathProblem(local: string): string | null {
  const p = local.trim();
  if (!p) return null;
  if (p === "~" || p === "~/" || p === "~\\") return "Pick files or folders in the home folder, not all of it.";
  if (p.startsWith("~/") || p.startsWith("~\\") || isFullPath(p)) return null;
  return "Give a full path, or one that starts with ~.";
}

export function remotePathProblem(remote: string): string | null {
  const t = remote.trim().replace(/\\/g, "/");
  const rest = t === "~" ? "" : t.startsWith("~/") ? t.slice(2) : t;
  if (rest.startsWith("/")) return "Give it below the home folder on the server, like .zshrc or ~/.zshrc.";
  if (rest.startsWith("~")) return "~user isn't supported: give it below the home folder.";
  if (rest.split("/").includes("..")) return "`..` isn't allowed: everything stays in the home folder.";
  return null;
}
