// Small per-device values kept as JSON in localStorage, best-effort like the
// other per-device prefs. A save can announce itself with a window event, so
// that every open view of the same key follows it; the storage event alone
// only reaches other windows.
import { useEffect, useState } from "react";

/** The parsed value; null when it is missing, unreadable, or storage is off. */
export const readStoredJson = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/** Saves the value and, if `event` is given, announces it (detail: the key). */
export const writeStoredJson = (key: string, value: unknown, event?: string) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ }
  if (event) window.dispatchEvent(new CustomEvent(event, { detail: key }));
};

/** The strings of a stored list; anything else in it, or no list, is left out. */
export const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];

/**
 * A list of strings under `key`, following every save made through this
 * hook anywhere in the app.
 */
export function useStoredList(key: string, event: string): [string[], (next: string[]) => void] {
  const [list, setList] = useState(() => stringsOf(readStoredJson(key)));
  useEffect(() => {
    const update = (changed: string | null) => {
      if (changed === null || changed === key) setList(stringsOf(readStoredJson(key)));
    };
    const onChange = (e: Event) => update((e as CustomEvent<string>).detail);
    const onStorage = (e: StorageEvent) => update(e.key);
    // A save between the first render and this subscription is not missed.
    update(key);
    window.addEventListener(event, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(event, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [key, event]);
  return [list, (next) => writeStoredJson(key, next, event)];
}
