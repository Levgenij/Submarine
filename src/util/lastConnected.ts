// When each server was last opened on this device, per profile (every profile
// has its own database). Keyed by the server's uuid: it is stable across
// devices and reorders. Kept per device only, like the other view prefs.
import { useEffect, useState } from "react";
import { readStoredJson, writeStoredJson } from "./storedJson";

const EVENT = "submarine-last-connected";
const keyFor = (profile: string) => `submarine-last-connected:${profile}`;

const read = (key: string): Record<string, number> => {
  const v = readStoredJson(key);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
};

export function markConnected(profile: string | null | undefined, uuid: string | null | undefined) {
  if (!profile || !uuid) return;
  const key = keyFor(profile);
  writeStoredJson(key, { ...read(key), [uuid]: Date.now() }, EVENT);
}

/** uuid → ms of the last open here, following every save. */
export function useLastConnected(profile: string | null | undefined): Record<string, number> {
  const key = profile ? keyFor(profile) : "";
  const [map, setMap] = useState(() => (key ? read(key) : {}));
  useEffect(() => {
    if (!key) { setMap({}); return; }
    const update = (changed: string | null) => { if (changed === null || changed === key) setMap(read(key)); };
    const onChange = (e: Event) => update((e as CustomEvent<string>).detail);
    const onStorage = (e: StorageEvent) => update(e.key);
    update(key);
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  return map;
}
