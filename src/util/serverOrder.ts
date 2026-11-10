// Ordering and lettered groups for the server list (Cards and Tree views).
// "manual" keeps the stored order (`position, id` from get_servers), which is
// the one drag-to-reorder edits.

export type SortKey = "manual" | "name" | "host" | "recent";
export type SortDir = "asc" | "desc";

export const SORT_KEYS: SortKey[] = ["manual", "name", "host", "recent"];

// numeric: "web2" before "web10"; base: case and accents don't split names apart.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byText = (a: string, b: string) => collator.compare(a || "", b || "");

/** `list` in the given order; `lastSeen` maps a server's uuid to when it was last opened here. */
export function sortServers<T extends { name?: string; host?: string; uuid?: string }>(
  list: T[], key: SortKey, dir: SortDir, lastSeen: Record<string, number> = {},
): T[] {
  if (key === "manual") return list;
  const sign = dir === "desc" ? -1 : 1;
  const seen = (s: T) => (s.uuid && lastSeen[s.uuid]) || 0;
  return [...list].sort((a, b) => {
    if (key === "recent") {
      const ta = seen(a), tb = seen(b);
      // Never-opened servers stay at the end whichever way the list runs.
      if (!ta || !tb) return (ta ? -1 : 0) + (tb ? 1 : 0) || byText(a.name ?? "", b.name ?? "");
      // Ascending means most recent first: that is what "Last connected" is read for.
      return sign * (tb - ta) || byText(a.name ?? "", b.name ?? "");
    }
    const primary = key === "host" ? byText(a.host ?? "", b.host ?? "") : byText(a.name ?? "", b.name ?? "");
    return sign * (primary || byText(a.name ?? "", b.name ?? ""));
  });
}

/** Folders have only a name: any sort but "manual" orders them by it (descending only for a name sort). */
export function sortFolders<T extends { name?: string }>(list: T[], key: SortKey, dir: SortDir): T[] {
  if (key === "manual") return list;
  const sign = key === "name" && dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => sign * byText(a.name ?? "", b.name ?? ""));
}

/** `ids` without `id`, then `id` put just before or after `targetId` (at the end if that's missing). */
export function placeAt(ids: number[], id: number, targetId: number, before: boolean): number[] {
  const out = ids.filter((x) => x !== id);
  const at = out.indexOf(targetId);
  out.splice(at < 0 ? out.length : at + (before ? 0 : 1), 0, id);
  return out;
}

/** The group a name files under: its first letter without accents, or "#" for anything else. */
export function letterOf(name: string | undefined): string {
  const first = Array.from((name ?? "").trim())[0] ?? "";
  const bare = first.normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase();
  return /^\p{L}$/u.test(bare) ? bare : "#";
}

/** Consecutive runs of the same letter, in the list's own order; "#" always last. */
export function groupByLetter<T extends { name?: string }>(list: T[]): { letter: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const s of list) {
    const l = letterOf(s.name);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(s);
  }
  const out = [...groups].map(([letter, items]) => ({ letter, items }));
  return [...out.filter((g) => g.letter !== "#"), ...out.filter((g) => g.letter === "#")];
}

/** "10 min ago", "Yesterday"… for a time in ms; "Never" for none. */
export function relativeTime(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "Never";
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.ceil((startOfToday - ms) / 86_400_000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString();
}
