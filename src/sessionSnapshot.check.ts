import { buildSnapshot, parseSnapshot, MAX_SNAP_SESSIONS, MAX_SNAP_TERMS } from "./sessionSnapshot.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: ${a} !== ${e}`);
  }
}

const all = () => true;
const term = (id: string, title: string) => ({ id, title });

// Build: quick-connect dropped, active tab and session remembered, empty tab list falls back.
const built = buildSnapshot({
  sessions: [
    { id: "session-quick-1", serverId: 0 },
    { id: "session-3", serverId: 3, customName: "prod" },
    { id: "session-5", serverId: 5 },
  ],
  terminalsBySession: {
    "session-3": [term("a", "1"), { id: "b", title: "logs", container: { name: "web", useSudo: true } }],
  },
  activeTermBySession: { "session-3": "b" },
  activeView: "session-3",
});
eq(built.activeServerId, 3, "active server");
eq(built.sessions.map((s) => s.serverId), [3, 5], "quick-connect dropped");
eq(built.sessions[0], {
  serverId: 3,
  customName: "prod",
  terminals: [{ title: "1" }, { title: "logs", container: { name: "web", useSudo: true } }],
  activeIndex: 1,
}, "session with tabs");
eq(built.sessions[1], { serverId: 5, terminals: [{ title: "1" }], activeIndex: 0 }, "no reported tabs");

// Round trip.
eq(parseSnapshot(JSON.stringify(built), all), { sessions: built.sessions, activeServerId: 3 }, "round trip");

// Caps.
const many = buildSnapshot({
  sessions: Array.from({ length: 30 }, (_, i) => ({ id: `session-${i + 1}`, serverId: i + 1 })),
  terminalsBySession: { "session-1": Array.from({ length: 15 }, (_, i) => term(`t${i}`, `${i + 1}`)) },
  activeTermBySession: { "session-1": "t14" },
  activeView: "nodes",
});
eq(many.sessions.length, MAX_SNAP_SESSIONS, "build caps sessions");
eq(many.sessions[0].terminals.length, MAX_SNAP_TERMS, "build caps tabs");
eq(many.sessions[0].activeIndex, 0, "active tab past the cap falls back to the first");
eq(many.activeServerId, null, "no active session");
const rawMany = JSON.stringify({
  sessions: Array.from({ length: 30 }, (_, i) => ({ serverId: i + 1, terminals: Array.from({ length: 15 }, () => ({ title: "x" })) })),
});
const parsedMany = parseSnapshot(rawMany, all);
eq(parsedMany.sessions.length, MAX_SNAP_SESSIONS, "parse caps sessions");
eq(parsedMany.sessions[0].terminals.length, MAX_SNAP_TERMS, "parse caps tabs");
eq(parseSnapshot(JSON.stringify({ activeServerId: 25, sessions: JSON.parse(rawMany).sessions }), all).activeServerId, null, "active server past the cap");

// Untrusted input.
const empty = { sessions: [], activeServerId: null };
eq(parseSnapshot(null, all), empty, "missing");
eq(parseSnapshot("{not json", all), empty, "corrupt json");
eq(parseSnapshot('{"sessions":5}', all), empty, "wrong shape");
eq(parseSnapshot("null", all), empty, "json null");
const junk = parseSnapshot(JSON.stringify({
  activeServerId: 9,
  sessions: [
    null,
    { serverId: 0 },
    { serverId: -1 },
    { serverId: "4" },
    { serverId: 1.5 },
    { serverId: 9 },
    { serverId: 2, customName: "  ", activeIndex: 99, terminals: [{ title: 7 }, { title: "x".repeat(80), container: { name: "", useSudo: "yes" } }] },
    { serverId: 2, customName: "dup" },
    { serverId: 6, activeIndex: -3, terminals: "nope", customName: 12 },
    { serverId: 7, customName: `  ${"n".repeat(70)}  `, terminals: [{ title: " db ", container: { name: "web-1", useSudo: "yes" } }] },
  ],
}), (id) => id !== 9);
eq(junk.activeServerId, null, "active server that no longer exists");
eq(junk.sessions, [
  { serverId: 2, terminals: [{ title: "1" }, { title: "x".repeat(60) }], activeIndex: 1 },
  { serverId: 6, terminals: [{ title: "1" }], activeIndex: 0 },
  { serverId: 7, customName: "n".repeat(60), terminals: [{ title: "db", container: { name: "web-1", useSudo: false } }], activeIndex: 0 },
], "junk entries dropped, fields normalized, duplicates skipped");

console.log("sessionSnapshot ok");
