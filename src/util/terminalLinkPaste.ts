// Decisions for the terminal's confirm dialogs: which OSC 8 targets may be
// opened, and when a paste must be confirmed before it is sent.

const LINK_LIMIT = 300;
const PREVIEW_LINES = 4;
const PREVIEW_WIDTH = 70;

export interface HttpLinkPrompt {
  host: string;
  shown: string;
}

/** http(s) only. Other schemes, and targets that do not parse, are ignored. */
export function httpLinkPrompt(uri: string): HttpLinkPrompt | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  let host: string;
  try {
    host = new URL(uri).host;
  } catch {
    return null;
  }
  // A very long target is cut so the dialog's buttons stay on screen. The
  // host is still the real one, and the full target is what gets opened.
  const shown = uri.length > LINK_LIMIT ? `${uri.slice(0, LINK_LIMIT)}…` : uri;
  return { host, shown };
}

export interface MultilinePastePrompt {
  count: number;
  preview: string;
}

/**
 * More than one line into a program that has not turned bracketed paste on.
 * A single trailing line break does not count as another line. Returns null
 * when the paste should go through without a question.
 */
export function multilinePastePrompt(text: string, bracketedPaste: boolean): MultilinePastePrompt | null {
  const lines = text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
  if (lines.length <= 1 || bracketedPaste) return null;
  const preview = lines
    .slice(0, PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_WIDTH ? `${line.slice(0, PREVIEW_WIDTH)}…` : line))
    .join("\n");
  const more = lines.length > PREVIEW_LINES ? `\n… and ${lines.length - PREVIEW_LINES} more` : "";
  return { count: lines.length, preview: `${preview}${more}` };
}
