import { mergePermissions, permissionOctal, safeLeafName, shellSingleQuote } from "./dirContext.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
  }
}

eq(safeLeafName("  notes.txt  "), "notes.txt", "trim");
eq(safeLeafName(".."), null, "dotdot");
eq(safeLeafName("."), null, "dot");
eq(safeLeafName("a/b"), null, "slash");
eq(safeLeafName("a\\b"), null, "backslash");
eq(safeLeafName("a\0b"), null, "nul");
eq(safeLeafName("   "), null, "blank");
eq(shellSingleQuote("/var"), "'/var'", "plain quote");
eq(shellSingleQuote("/tmp/it's"), `'/tmp/it'"'"'s'`, "embedded quote");
eq(mergePermissions(0o2755, 0o755), 0o2755, "keep setgid");
eq(mergePermissions(0o1777, 0o755), 0o1755, "keep sticky");
eq(mergePermissions(undefined, 0o644), 0o644, "unknown mode");
eq(permissionOctal(0o2755), "755", "octal field");
eq(permissionOctal(0), "000", "zero mode");
eq(permissionOctal(undefined), "", "missing mode");

console.log("dirContext ok");
