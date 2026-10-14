import { httpLinkPrompt, multilinePastePrompt } from "./terminalLinkPaste.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: ${a} !== ${e}`);
}

eq(httpLinkPrompt("https://example.com/a"), { host: "example.com", shown: "https://example.com/a" }, "https");
eq(httpLinkPrompt("HTTP://Example.COM/x"), { host: "example.com", shown: "HTTP://Example.COM/x" }, "scheme case");
eq(httpLinkPrompt("http://example.com:8443/a"), { host: "example.com:8443", shown: "http://example.com:8443/a" }, "port");
eq(httpLinkPrompt("http://[::1]/x"), { host: "[::1]", shown: "http://[::1]/x" }, "ipv6");
eq(httpLinkPrompt("javascript:alert(1)"), null, "javascript");
eq(httpLinkPrompt("file:///etc/passwd"), null, "file");
eq(httpLinkPrompt("ftp://example.com/a"), null, "ftp");
eq(httpLinkPrompt("mailto:a@b.c"), null, "mailto");
eq(httpLinkPrompt(""), null, "empty");
eq(httpLinkPrompt("http://["), null, "unparsed");

const exact = "https://example.com/" + "a".repeat(300 - "https://example.com/".length);
eq(exact.length, 300, "300 fixture");
eq(httpLinkPrompt(exact)?.shown, exact, "300 stays");
const longer = exact + "b";
eq(httpLinkPrompt(longer), { host: "example.com", shown: `${exact}…` }, "301 cut");

eq(multilinePastePrompt("echo hi", false), null, "single line");
eq(multilinePastePrompt("echo hi\n", false), null, "trailing lf");
eq(multilinePastePrompt("echo hi\r\n", false), null, "trailing crlf");
eq(multilinePastePrompt("echo hi\r", false), null, "trailing cr");
eq(multilinePastePrompt("a\nb", true), null, "bracketed");
eq(multilinePastePrompt("a\r\nb\r\n", false), { count: 2, preview: "a\nb" }, "crlf pair");
eq(multilinePastePrompt("a\nb\n", false), { count: 2, preview: "a\nb" }, "two plus trailing");
eq(multilinePastePrompt("a\nb\nc\nd", false), { count: 4, preview: "a\nb\nc\nd" }, "four lines");
eq(
  multilinePastePrompt("a\nb\nc\nd\ne", false),
  { count: 5, preview: "a\nb\nc\nd\n… and 1 more" },
  "five lines",
);
eq(
  multilinePastePrompt(["one", "two", "three", "four", "five", "six"].join("\n"), false),
  { count: 6, preview: "one\ntwo\nthree\nfour\n… and 2 more" },
  "six lines",
);
const seventy = "y".repeat(70);
eq(multilinePastePrompt(`${seventy}\nz`, false), { count: 2, preview: `${seventy}\nz` }, "70 stays");
eq(
  multilinePastePrompt(`${"x".repeat(71)}\ny`, false),
  { count: 2, preview: `${"x".repeat(70)}…\ny` },
  "71 cut",
);

console.log("terminalLinkPaste ok");
