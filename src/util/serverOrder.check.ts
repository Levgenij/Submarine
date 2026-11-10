import { sortServers, sortFolders, groupByLetter, letterOf, relativeTime, placeAt } from "./serverOrder.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: ${a} !== ${e}`);
}

const names = (rows: { name?: string }[]) => rows.map((s) => s.name);

const servers = [
  { name: "web10", host: "10.0.0.3", uuid: "a" },
  { name: "Alpha", host: "10.0.0.20", uuid: "b" },
  { name: "web2", host: "10.0.0.1", uuid: "c" },
  { name: "Ёлка", host: "h", uuid: "d" },
  { name: "Élan", host: "h", uuid: "e" },
  { name: "1-box", host: "h", uuid: "f" },
  { name: "beta", host: "h", uuid: "g" },
];

eq(sortServers(servers, "manual", "desc"), servers, "manual keeps the stored order");
eq(names(sortServers(servers.slice(0, 3), "name", "asc")), ["Alpha", "web2", "web10"], "numbers inside names sort as numbers");
eq(names(sortServers(servers.slice(0, 3), "name", "desc")), ["web10", "web2", "Alpha"], "descending");
eq(names(sortServers(servers.slice(0, 3), "host", "asc")), ["web2", "web10", "Alpha"], "by host");

const seen = { a: 100, c: 300 };
eq(names(sortServers(servers.slice(0, 3), "recent", "asc", seen)), ["web2", "web10", "Alpha"], "recent: newest first, never last");
eq(names(sortServers(servers.slice(0, 3), "recent", "desc", seen)), ["web10", "web2", "Alpha"], "recent desc: never still last");

eq(names(sortFolders([{ name: "b" }, { name: "A" }], "host", "desc")), ["A", "b"], "folders by name for other sorts");
eq(names(sortFolders([{ name: "b" }, { name: "A" }], "name", "desc")), ["b", "A"], "folders follow a name sort's direction");

eq(letterOf("  élan"), "E", "accents drop");
eq(letterOf("ёлка"), "Е", "cyrillic, without the diaeresis");
eq(letterOf("1-box"), "#", "digits go to #");
eq(letterOf(""), "#", "empty name");

const groups = groupByLetter(sortServers(servers, "name", "asc"));
// Where Cyrillic falls against Latin depends on the system locale, so only the Latin run is pinned.
eq(groups.map((g) => g.letter).filter((l) => l !== "Е"), ["A", "B", "E", "W", "#"], "groups in list order, # last");
eq(groups.some((g) => g.letter === "Е"), true, "cyrillic group");
eq(names(groups.find((g) => g.letter === "W")!.items), ["web2", "web10"], "a group keeps the list's order");

eq(placeAt([1, 2, 3, 4], 4, 2, true), [1, 4, 2, 3], "before the target");
eq(placeAt([1, 2, 3, 4], 1, 3, false), [2, 3, 1, 4], "after the target, moving down");
eq(placeAt([1, 2], 9, 2, false), [1, 2, 9], "a server from another folder, after the last");
eq(placeAt([1, 2], 9, 7, true), [1, 2, 9], "missing target: at the end");

const now = new Date(2026, 10, 9, 15, 0).getTime();
eq(relativeTime(undefined, now), "Never", "never");
eq(relativeTime(now - 20_000, now), "Just now", "seconds");
eq(relativeTime(now - 10 * 60_000, now), "10 min ago", "minutes");
eq(relativeTime(now - 2 * 3_600_000, now), "2 hours ago", "hours today");
eq(relativeTime(new Date(2026, 10, 8, 23, 0).getTime(), now), "Yesterday", "yesterday evening");
eq(relativeTime(new Date(2026, 10, 6, 12, 0).getTime(), now), "3 days ago", "days");

console.log("serverOrder: ok");
