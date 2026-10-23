// Folders bookmarked in the SFTP panes. Kept on this device (localStorage),
// per profile (server ids restart in every profile's database), per saved
// server and per pane. A global bookmark is per profile and pane only, so it
// is listed in that pane of every server. Profile names hold only
// [A-Za-z0-9_-], so ":" keeps the parts of a key apart.
import { useEffect, useState } from "react";

export type BookmarkSide = "local" | "remote";

// Enough for any pane; a list can't grow without end.
export const BOOKMARKS_MAX = 50;

const PREFIX = "submarine-sftp-bookmarks:";

const profilePrefix = (profile: string) => `${PREFIX}${profile}:`;

export const bookmarksKey = (profile: string, serverId: number, side: BookmarkSide) =>
  `${profilePrefix(profile)}${serverId}:${side}`;

// Server ids are numbers, so "global" is never one of them.
export const globalBookmarksKey = (profile: string, side: BookmarkSide) =>
  `${profilePrefix(profile)}global:${side}`;

// Sent on `window` when a list is written, with its key as `detail`, so a
// global bookmark made in one session shows in every open one.
const CHANGED = "submarine-sftp-bookmarks-changed";

// What is stored under `key`: strings only, each once, at most BOOKMARKS_MAX.
export function readBookmarks(key: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved)) return [];
    const paths = saved.filter((p): p is string => typeof p === "string" && p.length > 0);
    return [...new Set(paths)].slice(0, BOOKMARKS_MAX);
  } catch {
    return [];
  }
}

export function writeBookmarks(key: string, paths: string[]) {
  try {
    if (paths.length > 0) localStorage.setItem(key, JSON.stringify(paths));
    else localStorage.removeItem(key);
  } catch { /* storage full or off: the bookmark lasts until the pane closes */ }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
}

/**
 * The list under `key`, following every write to it from any pane, and a
 * setter that writes it. No key (a server that isn't saved): an empty list
 * that stays empty.
 */
export function useBookmarks(key: string | undefined): [string[], (paths: string[]) => void] {
  const [paths, setPaths] = useState<string[]>(() => (key ? readBookmarks(key) : []));
  useEffect(() => {
    setPaths(key ? readBookmarks(key) : []);
    if (!key) return;
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setPaths(readBookmarks(key));
    };
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [key]);
  return [paths, (next) => { if (key) writeBookmarks(key, next); }];
}

// Drops every key that starts with `prefix`.
function forget(prefix: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* storage off: nothing was kept */ }
}

// A deleted profile's, global ones included: a new profile of the same name
// starts its server ids at 1 again, and must not find these.
export const forgetProfileBookmarks = (profile: string) => forget(profilePrefix(profile));

// A deleted server's, in both panes. Global bookmarks are not a server's.
export const forgetServerBookmarks = (profile: string, serverId: number) =>
  forget(`${profilePrefix(profile)}${serverId}:`);
