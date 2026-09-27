// A new file or link name is one path component. Reject separators so the
// dialog cannot escape the directory that was right-clicked.
export function safeLeafName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === "." || name === "..") return null;
  if (/[\\/\0]/.test(name)) return null;
  return name;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// The properties dialog edits only the lower 9 mode bits. Bits above that
// (setuid, setgid, sticky) stay as the server reported them.
export function mergePermissions(known: number | undefined, edited: number): number {
  const low = edited & 0o777;
  if (known == null) return low;
  return (known & ~0o777) | low;
}

export function permissionOctal(mode: number | undefined): string {
  if (mode == null) return "";
  return (mode & 0o777).toString(8).padStart(3, "0");
}
