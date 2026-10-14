import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus, Trash2, X, AlertTriangle, ArrowRight, Download, Upload,
  CheckCircle2, Cloud, CloudOff, HardDrive, ChevronDown, RefreshCw, ArrowUpCircle,
  Eye, EyeOff, ArrowBigUp, Check,
} from "lucide-react";
import CloudPanel from "./CloudPanel";
import { bookmarksKeyPrefix } from "./SftpWorkspace";
import { snapshotKey } from "../sessionSnapshot";
import logoUrl from "../assets/logo.png";
import { IS_ANDROID } from "../util/platform";
import { useTextPrompt, useConfirm } from "../ui/confirm";

// Vault file header (lib.rs VAULT_MAGIC / VAULT_VERSION) — checked up front on
// Android imports so a wrong file fails before the user picks a name.
const VAULT_MAGIC = "OMNV";
const VAULT_VERSION = 1;

// Base64 in 32 KB chunks: spreading a large Uint8Array into one
// String.fromCharCode call would overflow the call stack.
const bytesToBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

interface CloudStatus { signed_in: boolean; email: string | null; }
// One personal profile as reported by the cloud (GET /sync/profiles). Names +
// counts only — the server never sees the encrypted contents. `profile` is the
// partition key (a name for legacy profiles, a UUID for new ones); `name` is the
// human-readable label to show and to restore under.
interface CloudProfile { profile: string; name: string; records: number; live_records: number; last_updated: string; }
// Result of the GitHub release check (backend: about::check_for_updates).
// `has_update` is true only when `latest` is a strictly newer semver than the
// running build.
interface UpdateInfo { current: string; latest: string | null; has_update: boolean; release_url: string | null; }
// The running version and the project's GitHub page (backend: about::app_info).
interface AppInfo { version: string; github_repo_url: string; }
// The GitHub link's fallback, should app_info ever fail (about::GITHUB_REPO).
const REPO_URL = "https://github.com/SinaXhpm/Submarine";

// The picker's unit of display: one profile, wherever it lives. `local` = an
// on-disk vault exists here; `cloud` = the matching cloud partition (or null).
// Merging local + cloud into a single row is what lets the login screen be the
// one place to SEE and MANAGE every profile — open it, export it, remove it
// here, get it from the cloud, or delete it from the cloud.
interface Row { name: string; local: boolean; cloud: CloudProfile | null; }

// The profile opened last on this device is the one picked when the page
// opens. Only its name is kept. Storage can be unavailable, so every access
// is guarded; the first profile is picked then.
const LAST_PROFILE_KEY = "submarine-last-profile";
const lastProfile = () => {
  try { return localStorage.getItem(LAST_PROFILE_KEY) ?? ""; } catch { return ""; }
};
const rememberProfile = (name: string) => {
  try { localStorage.setItem(LAST_PROFILE_KEY, name); } catch { /* the first profile is picked instead */ }
};
const forgetLastProfile = (name: string) => {
  try { if (localStorage.getItem(LAST_PROFILE_KEY) === name) localStorage.removeItem(LAST_PROFILE_KEY); } catch { /* nothing kept */ }
};

// The backend's rules for a profile name (lib.rs validate_profile_name),
// checked while it's typed, plus the names already taken. Case doesn't count:
// the list matches names that way, and so do Windows file names.
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;
const nameProblem = (name: string, local: string[], cloud: string[]): string | null => {
  if (!name) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return "Use letters, numbers, - and _ only.";
  if (name.length > 32) return "Use 32 characters at most.";
  if (RESERVED_NAME.test(name)) return `"${name}" is a reserved name on Windows.`;
  const key = name.toLowerCase();
  const here = local.find((p) => p.toLowerCase() === key);
  if (here) return `There's already a profile named "${here}".`;
  // A new profile is a different one, even under the same name: it would sit
  // in the list as if it were the cloud one.
  const there = cloud.find((p) => p.toLowerCase() === key);
  if (there) return `"${there}" is in your cloud. Get it from the list, or pick another name.`;
  return null;
};

// A short side-to-side nudge for a refused entry, skipped when the system asks
// for less motion. The Web Animations API leaves no transform behind.
const shake = (el: HTMLElement | null | undefined) => {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [0, -7, 6, -4, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: 380, easing: "ease-out" },
  );
};

// Whether Caps Lock is on. A page only learns it from an event, so every key
// and click reads it.
const useCapsLock = () => {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = (e: KeyboardEvent | MouseEvent) => {
      if (typeof e.getModifierState === "function") setOn(e.getModifierState("CapsLock"));
    };
    window.addEventListener("keydown", read, true);
    window.addEventListener("keyup", read, true);
    window.addEventListener("mousedown", read, true);
    return () => {
      window.removeEventListener("keydown", read, true);
      window.removeEventListener("keyup", read, true);
      window.removeEventListener("mousedown", read, true);
    };
  }, []);
  return on;
};

const withInvalid = (className: string, invalid: boolean) =>
  invalid
    ? className.replaceAll("border-white/5", "border-rose-500/50").replaceAll("focus:border-primary/50", "focus:border-rose-400/70")
    : className;

interface Props {
  onUnlocked: (profileName: string) => void;
}

const ProfileSelectPage = ({ onUnlocked }: Props) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The expanded row (by display name). A local row expands to a password +
  // Open + actions; a cloud-only row expands to Get + Delete-from-cloud.
  const [selected, setSelected] = useState<string>("");
  const [password, setPassword] = useState("");
  // Why the last unlock failed, under the password box.
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  // Set by a Create click with something missing: the rules not met yet turn red.
  const [triedCreate, setTriedCreate] = useState(false);
  // Why the backend refused the new profile.
  const [createError, setCreateError] = useState<string | null>(null);

  // Import is a two-step flow: pick file (backend validates header) → prompt
  // for the profile name to save it under. We keep the picked path here so
  // the second step can pass it back to Rust on commit.
  // Desktop stages a file path (native dialog); Android stages the file's
  // bytes (base64) read from the system file picker via <input type="file">.
  const [importStaged, setImportStaged] = useState<{ sourcePath?: string; bytesB64?: string; name: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);

  // Cloud status surfaced directly on this page so the user doesn't have
  // to open the modal just to know if sync is connected or pending.
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>({ signed_in: false, email: null });
  // Profiles that live in the signed-in cloud account. Merged with the local
  // list below so a fresh device SHOWS the user's profiles instead of making
  // them remember and type a name. Empty until signed in (or on network error).
  const [cloudProfiles, setCloudProfiles] = useState<CloudProfile[]>([]);
  // A newer published release than the running build, if any. Set only when
  // one actually exists, so the notice under the footer appears solely when
  // there's something to announce.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Footer: the version + GitHub link, and how the last "Check for updates"
  // click went.
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "latest" | "none" | "error">("idle");
  const [checkError, setCheckError] = useState("");
  // A link that can't be opened (no browser / URL handler on this device)
  // says so under the footer row instead of doing nothing.
  const [linkError, setLinkError] = useState("");

  const textPrompt = useTextPrompt();
  const confirm = useConfirm();
  const capsLock = useCapsLock();

  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const newPasswordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);
  const importNameRef = useRef<HTMLInputElement | null>(null);

  // The row to open when none is: the profile opened last here, else the first.
  const pickFrom = (list: string[], prev: string) => {
    if (prev && list.includes(prev)) return prev;
    const last = lastProfile();
    return list.includes(last) ? last : list[0] || "";
  };

  // Clean the [PREFIX] off backend errors for display.
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
      setSelected((prev) => pickFrom(list, prev));
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // Cloud connection + the account's profile list. Best-effort: a network
  // failure must never block unlocking a local profile, so errors are swallowed
  // and just leave the cloud side empty.
  const refreshCloud = useCallback(async () => {
    try {
      const s = await invoke<CloudStatus>("cloud_status");
      setCloudStatus(s);
      if (s.signed_in) {
        try {
          const cps = await invoke<CloudProfile[]>("cloud_list_sync_profiles");
          // Hide empty / retired partitions (all-tombstone or escrow-only) —
          // they'd just be noise in the picker.
          setCloudProfiles(cps.filter((c) => c.live_records > 0));
        } catch {
          setCloudProfiles([]);
        }
      } else {
        setCloudProfiles([]);
      }
    } catch {
      // swallow — network down, modal can still be opened to retry
    }
  }, []);

  useEffect(() => { refreshCloud(); }, [refreshCloud]);

  // Check GitHub for a newer release once per app open (this page mounts on
  // launch and on every return to the picker). Best-effort and silent: the
  // fetch+semver-compare happens in Rust (about::check_for_updates), and any
  // failure — offline, rate-limited, no releases — simply shows nothing.
  useEffect(() => {
    invoke<UpdateInfo>("check_for_updates")
      .then((u) => { if (u.has_update && u.latest) setUpdate(u); })
      .catch(() => {});
  }, []);

  const openLink = (url: string) => {
    setLinkError("");
    invoke("open_external_url", { url }).catch((e) => setLinkError(`Couldn't open the link: ${cleanErr(e)}`));
  };

  const openReleaseNotes = () => {
    if (update?.release_url) openLink(update.release_url);
  };

  useEffect(() => {
    invoke<AppInfo>("app_info").then(setAppInfo).catch(() => {});
  }, []);

  const openRepo = () => openLink(appInfo?.github_repo_url ?? REPO_URL);

  // The footer's "Check for updates". Unlike the silent check above it reports
  // every outcome; a newer release lands in `update`, so the same notice
  // announces it.
  const checkForUpdates = async () => {
    if (check === "checking") return;
    setCheck("checking");
    try {
      const u = await invoke<UpdateInfo>("check_for_updates");
      if (u.has_update && u.latest) {
        setUpdate(u);
        setCheck("idle");
      } else {
        setCheck(u.latest ? "latest" : "none");
      }
    } catch (e) {
      setCheckError(cleanErr(e));
      setCheck("error");
    }
  };

  // When the expanded row changes, reset + focus the password so opening a
  // profile is always "click row, type, Enter". Closing the row drops the
  // unlock error with it.
  useEffect(() => {
    setPassword("");
    setUnlockError(null);
    setError(null);
    requestAnimationFrame(() => passwordInputRef.current?.focus());
  }, [selected]);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [creating]);

  // Merge local + cloud into one ordered list, matched case-insensitively by
  // display name (a local file and its cloud partition are the SAME profile
  // even though the partition key may be an opaque UUID). Local-first, then
  // alphabetical, so the profiles already on this device sit up top.
  const buildRows = (): Row[] => {
    const byKey = new Map<string, Row>();
    for (const p of profiles) byKey.set(p.toLowerCase(), { name: p, local: true, cloud: null });
    for (const c of cloudProfiles) {
      const k = c.name.toLowerCase();
      const existing = byKey.get(k);
      if (existing) existing.cloud = c;
      else byKey.set(k, { name: c.name, local: false, cloud: c });
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.local !== b.local ? (a.local ? -1 : 1) : a.name.localeCompare(b.name)
    );
  };
  const rows = buildRows();

  const toggle = (row: Row) => setSelected((prev) => (prev === row.name ? "" : row.name));

  const openCreate = () => {
    setCreating(true);
    setPassword("");
    setUnlockError(null);
    setError(null);
    setInfo(null);
    setNewName("");
    setNewPassword("");
    setNewConfirmPassword("");
    setTriedCreate(false);
    setCreateError(null);
  };

  // Leaving the form forgets what was typed in it, passwords included.
  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewPassword("");
    setNewConfirmPassword("");
    setTriedCreate(false);
    setCreateError(null);
    setError(null);
  };

  const unlockSelected = async () => {
    const name = selected;
    if (!name || !password || busy) return;
    setBusy(true); setUnlockError(null); setError(null);
    try {
      await invoke("select_profile", { name });
      await invoke("setup_master_db", { password });
    } catch (e: unknown) {
      const raw = String(e);
      setUnlockError(raw.toLowerCase().includes("decrypt") ? "Wrong password." : cleanErr(e));
      setBusy(false);
      shake(passwordInputRef.current?.parentElement);
      // Selected, so the next try types over it.
      requestAnimationFrame(() => {
        const el = passwordInputRef.current;
        el?.focus();
        el?.select();
      });
      return;
    }
    rememberProfile(name);
    onUnlocked(name);
  };

  const createNew = async () => {
    if (busy) return;
    const name = newName.trim();
    const issue = nameProblem(name, profiles, cloudProfiles.map((c) => c.name));
    const longEnoughNow = [...newPassword].length >= 8;
    const matchesNow = newConfirmPassword.length > 0 && newPassword === newConfirmPassword;
    if (!name || issue || !longEnoughNow || !matchesNow) {
      setTriedCreate(true);
      const el = !name || issue ? nameInputRef.current : !longEnoughNow ? newPasswordRef.current : confirmRef.current;
      el?.focus();
      shake(el === nameInputRef.current ? el : el?.parentElement);
      return;
    }
    setBusy(true); setCreateError(null); setError(null);
    try {
      await invoke("create_profile", { name, password: newPassword });
    } catch (e: unknown) {
      setCreateError(cleanErr(e));
      setBusy(false);
      return;
    }
    rememberProfile(name);
    onUnlocked(name);
  };

  const exportProfile = async (name: string) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      // Returns the chosen path on success, null if the user cancelled the
      // save dialog. We only surface a toast in the success case.
      const saved = await invoke<string | null>("export_profile", { name });
      if (saved) setInfo(`Exported to ${saved}`);
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    setError(null); setInfo(null);
    // Android: no native dialog — the WebView's file input opens the system
    // picker (Downloads, Drive, messengers…) and hands us the file.
    if (IS_ANDROID) { importFileRef.current?.click(); return; }
    setBusy(true);
    try {
      const picked = await invoke<[string, string] | null>("import_profile_pick");
      if (!picked) { setBusy(false); return; }
      const [sourcePath, suggested] = picked;
      setImportStaged({ sourcePath, name: suggested });
      requestAnimationFrame(() => importNameRef.current?.select());
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const onImportFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again later
    if (!file) return;
    setError(null); setInfo(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Same quick header check the backend does, for instant feedback.
      if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 4)) !== VAULT_MAGIC || bytes[4] !== VAULT_VERSION) {
        setError("That file isn't a Submarine profile.");
        return;
      }
      const suggested = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "imported";
      setImportStaged({ bytesB64: bytesToBase64(bytes), name: suggested });
      requestAnimationFrame(() => importNameRef.current?.select());
    } catch (err: any) {
      setError(cleanErr(err));
    }
  };

  const cancelImport = () => { setImportStaged(null); setError(null); };

  const commitImport = async () => {
    if (!importStaged || busy) return;
    const trimmed = importStaged.name.trim();
    // An imported file is a profile of its own, so only names on this device
    // are taken; the cloud one of the same name may well be this very profile.
    const issue = nameProblem(trimmed, profiles, []);
    if (!trimmed || issue) { importNameRef.current?.focus(); shake(importNameRef.current); return; }
    setBusy(true); setError(null);
    try {
      if (importStaged.bytesB64) {
        await invoke("import_profile_bytes", { name: trimmed, data: importStaged.bytesB64 });
      } else {
        await invoke("import_profile_save", { sourcePath: importStaged.sourcePath, name: trimmed });
      }
      setImportStaged(null);
      setInfo(`Imported as "${trimmed}". Open it with the original password.`);
      await reload();
      setSelected(trimmed);
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  // Remove the on-disk copy. If the profile is also in the cloud, it stays
  // there and can be pulled back with its password; if not, it's gone for good
  // — the confirm wording says which.
  const removeLocal = async (name: string) => {
    const inCloud = cloudProfiles.some((c) => c.name.toLowerCase() === name.toLowerCase());
    const ok = await confirm({
      title: "Remove from this device",
      message: inCloud
        ? `Remove "${name}" from this device?\n\nThe encrypted file here is deleted. It stays in your cloud — you can Get it again anytime with its password.`
        : `Remove "${name}" from this device?\n\nThe encrypted file here is deleted. This profile is not in your cloud, so it will be gone for good.`,
      destructive: true,
      okLabel: "Remove",
    });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await invoke("delete_profile", { name });
      // Server ids restart in a new profile of the same name; its servers must not inherit these.
      const prefix = bookmarksKeyPrefix(name);
      Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem(snapshotKey(name));
      forgetLastProfile(name);
      await reload();
      refreshCloud();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  // Owner-only hard delete of the cloud copy (the /sync store is per-account, so
  // you can only ever delete your own). Local copies are untouched.
  const deleteFromCloud = async (row: Row) => {
    if (!row.cloud) return;
    const ok = await confirm({
      title: "Delete from cloud",
      message: `Delete "${row.name}" from your cloud?\n\nThis erases its synced copy and its restore key from the cloud. Copies already on your devices are NOT touched. This can't be undone.`,
      destructive: true,
      okLabel: "Delete from cloud",
    });
    if (!ok) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const n = await invoke<number>("cloud_delete_profile", { profile: row.cloud.profile });
      setInfo(`Removed "${row.name}" from the cloud (${n} record${n === 1 ? "" : "s"}).`);
      if (!row.local) setSelected((prev) => (prev === row.name ? "" : prev));
      await refreshCloud();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  // Bring a cloud profile onto this device using nothing but its own password:
  // that password unseals the cloud copy's key AND protects the copy saved
  // here. One field, no separate recovery secret.
  const bringDown = async (c: CloudProfile) => {
    setError(null); setInfo(null);
    const pw = await textPrompt({
      title: `Get "${c.name}"`,
      message: "Enter THIS profile's password — the same one you open it with. It unlocks the cloud copy and protects the copy saved on this device.",
      placeholder: "Profile password",
      password: true,
      // This prompt only. The default still trims every other text prompt.
      keepWhitespace: true,
      okLabel: "Get it",
      validate: (v: string) => (v.length < 1 ? "Enter the password" : null),
    });
    if (pw === null) return;
    setBusy(true);
    try {
      const rep = await invoke<{ pushed: number; pulled: number }>("restore_personal_profile", {
        cloudProfile: c.profile, localName: c.name, vaultPassword: pw,
      });
      setInfo(`"${c.name}" is now on this device — pulled ${rep.pulled} item${rep.pulled === 1 ? "" : "s"}. Open it below with the same password.`);
      await reload();
      setSelected(c.name);
      refreshCloud();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const inputBase =
    "w-full h-11 px-4 bg-zinc-900/40 border border-white/5 rounded-xl text-[14px] text-zinc-50 placeholder:text-zinc-600 outline-none focus:border-primary/50 focus:bg-zinc-900/60 transition-colors";
  const passwordInputClass =
    "w-full h-11 pl-4 bg-zinc-900/40 border border-white/5 rounded-xl text-[14px] text-zinc-50 placeholder:text-zinc-600 outline-none focus:border-primary/50 focus:bg-zinc-900/60 transition-colors";

  // The create form's checks, live. Length counts characters the way the
  // backend does (code points, not UTF-16 units).
  const nameIssue = nameProblem(newName.trim(), profiles, cloudProfiles.map((c) => c.name));
  const nameHint = nameIssue ?? (triedCreate && !newName.trim() ? "Give the profile a name." : null);
  const longEnough = [...newPassword].length >= 8;
  const passwordsMatch = newConfirmPassword.length > 0 && newPassword === newConfirmPassword;
  const createReady = !!newName.trim() && !nameIssue && longEnough && passwordsMatch;
  // Same name rules as create, except a cloud name is not a clash: the file
  // may be that profile.
  const importIssue = importStaged ? nameProblem(importStaged.name.trim(), profiles, []) : null;

  const onCreateKey = (e: React.KeyboardEvent<HTMLInputElement>, next: HTMLInputElement | null) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (createReady) createNew();
    else if (next) next.focus();
    else createNew();
  };

  // First run (nothing anywhere) drops straight into create; a returning user
  // on a fresh device (cloud profiles, no local) still sees the list so they
  // can Get them. `creating` is the explicit "New profile" toggle.
  const showCreate = creating || (!loading && profiles.length === 0 && cloudProfiles.length === 0);

  // What the footer's update item shows for each outcome of the manual check.
  const checkItem = {
    idle: { label: "Check for updates", icon: <RefreshCw size={12} />, tone: undefined },
    checking: { label: "Checking…", icon: <RefreshCw size={12} className="animate-spin" />, tone: undefined },
    latest: { label: "Up to date", icon: <CheckCircle2 size={12} />, tone: "text-emerald-400/90 hover:text-emerald-300" },
    none: { label: "No releases yet", icon: <RefreshCw size={12} />, tone: undefined },
    error: { label: "Couldn't check", icon: <AlertTriangle size={12} />, tone: "text-amber-400/90 hover:text-amber-300" },
  }[check];

  return (
    // Scrolls when the content is taller than the screen (phones with the
    // keyboard open); `m-auto` still centres it when there's room — plain
    // items-center would clip the top out of reach instead.
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-5 sm:px-6 py-8 sm:py-10 bg-background">
      <input
        ref={importFileRef}
        type="file"
        className="hidden"
        onChange={onImportFilePicked}
      />
      <div className="w-full max-w-[340px] m-auto flex flex-col">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8 select-none">
          <img
            src={logoUrl}
            alt=""
            draggable={false}
            className="h-28 w-auto max-w-full object-contain mb-4 drop-shadow-[0_0_32px_rgba(var(--primary),0.22)]"
          />
          <h1 className="text-[22px] font-semibold text-white tracking-tight leading-none">Submarine</h1>
          <p className="text-[10px] text-primary/80 mt-1.5 tracking-[0.22em] uppercase font-semibold">
            Run Silent, Run Deep
          </p>
          <p className="text-[12.5px] text-zinc-500 mt-2">
            {loading
              ? " "
              : showCreate
                ? (rows.length === 0 ? "Let's set up your first profile." : "Create a new profile.")
                : null}
          </p>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-200 text-[12.5px] flex items-start gap-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {info && !error && (
          <div className="mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-100 text-[12.5px] flex items-start gap-2">
            {/* Wraps instead of truncating: an Android export path is long and
                the user needs all of it to find the file. */}
            <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> <span className="flex-1 min-w-0 break-words">{info}</span>
            <button onClick={() => setInfo(null)} className="text-emerald-200/70 hover:text-white shrink-0"><X size={13} /></button>
          </div>
        )}

        {importStaged && (
          <div
            className="mb-3 px-3 py-3 bg-zinc-900/60 border border-primary/30 rounded-lg space-y-2 animate-in fade-in"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) { e.preventDefault(); cancelImport(); }
            }}
          >
            <div className="text-[11.5px] text-zinc-300 leading-snug">
              Importing a profile. Pick a name (the file's password is unchanged).
            </div>
            <input
              ref={importNameRef}
              value={importStaged.name}
              onChange={(e) => { setImportStaged({ ...importStaged, name: e.target.value }); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && commitImport()}
              placeholder="Profile name"
              aria-label="Name for the imported profile"
              aria-invalid={importIssue ? true : undefined}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={withInvalid(inputBase + " h-9 text-[13px]", !!importIssue)}
            />
            {importIssue && <FieldHint tone="error">{importIssue}</FieldHint>}
            <div className="flex gap-2">
              <button
                onClick={commitImport}
                disabled={busy || !importStaged.name.trim() || !!importIssue}
                className="flex-1 h-9 rounded-lg text-[12.5px] font-semibold bg-primary text-black disabled:opacity-50"
              >
                {busy ? "Importing…" : "Import"}
              </button>
              <button
                onClick={cancelImport}
                disabled={busy}
                className="h-9 px-3 rounded-lg text-[12.5px] font-semibold text-zinc-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center text-zinc-500 text-[12.5px] py-6">Loading…</div>
        ) : showCreate ? (
          /* ---- Create a profile ---- */
          <div
            className="space-y-3 animate-in fade-in"
            onKeyDown={(e) => {
              if (e.key === "Escape" && rows.length > 0 && !busy) { e.preventDefault(); closeCreate(); }
            }}
          >
            <div>
              <input
                ref={nameInputRef}
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                onKeyDown={(e) => onCreateKey(e, newPasswordRef.current)}
                placeholder="Profile name"
                aria-label="Profile name"
                aria-invalid={nameHint ? true : undefined}
                aria-describedby={nameHint ? "new-name-hint" : undefined}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={withInvalid(inputBase, !!nameHint)}
              />
              {nameHint && <FieldHint id="new-name-hint" tone="error">{nameHint}</FieldHint>}
            </div>
            <SecretInput
              ref={newPasswordRef}
              value={newPassword}
              onChange={(v) => { setNewPassword(v); setCreateError(null); }}
              onKeyDown={(e) => onCreateKey(e, confirmRef.current)}
              placeholder="Password"
              autoComplete="new-password"
              invalid={triedCreate && !longEnough}
              className={withInvalid(passwordInputClass, triedCreate && !longEnough)}
            />
            <SecretInput
              ref={confirmRef}
              value={newConfirmPassword}
              onChange={(v) => { setNewConfirmPassword(v); setCreateError(null); }}
              onKeyDown={(e) => onCreateKey(e, null)}
              placeholder="Confirm password"
              autoComplete="new-password"
              invalid={triedCreate && longEnough && !passwordsMatch}
              className={withInvalid(passwordInputClass, triedCreate && longEnough && !passwordsMatch)}
            />
            <ul className="flex list-none flex-wrap gap-x-4 gap-y-1.5 pl-0">
              <Rule ok={longEnough} strict={triedCreate}>At least 8 characters</Rule>
              <Rule ok={passwordsMatch} strict={triedCreate}>Both passwords match</Rule>
            </ul>
            {(createError || capsLock) && (
              <div aria-live="polite">
                {createError ? <FieldHint tone="error">{createError}</FieldHint> : <FieldHint tone="warn">Caps Lock is on</FieldHint>}
              </div>
            )}
            <button
              onClick={createNew}
              disabled={busy}
              className="w-full h-11 rounded-xl text-[14px] font-semibold bg-primary text-black hover:shadow-[0_0_24px_rgba(var(--primary),0.3)] disabled:opacity-50 flex items-center justify-center transition-all"
            >
              {busy ? "Creating…" : "Create profile"}
            </button>

            <div className="flex gap-2 pt-1">
              {rows.length > 0 && (
                <button
                  onClick={closeCreate}
                  disabled={busy}
                  className="flex-1 h-9 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/5 hover:border-white/10 text-zinc-400 hover:text-zinc-100 text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <X size={12} /> Cancel
                </button>
              )}
              <button
                onClick={startImport}
                disabled={busy}
                title="Import an exported .submarine file"
                className="flex-1 h-9 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/5 hover:border-white/10 text-zinc-400 hover:text-zinc-100 text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Upload size={12} /> Import
              </button>
            </div>

            <p className="text-[11.5px] text-zinc-500 leading-relaxed text-center px-2 pt-1">
              Profiles are encrypted. If you forget the password, the data is gone for good.
            </p>
          </div>
        ) : (
          /* ---- Your profiles (local + cloud, one list) ---- */
          <div className="space-y-3">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Your profiles</span>
              {cloudStatus.signed_in && (
                <button
                  onClick={refreshCloud}
                  disabled={busy}
                  title="Refresh from cloud"
                  className="text-zinc-600 hover:text-primary disabled:opacity-40 p-0.5"
                >
                  <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
                </button>
              )}
            </div>

            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden divide-y divide-white/5">
              {rows.map((row) => {
                const open = selected === row.name;
                return (
                  <div key={row.name}>
                    <button
                      onClick={() => toggle(row)}
                      className={`w-full flex items-center gap-2.5 px-3 h-11 text-left transition-colors ${open ? "bg-white/[0.03]" : "hover:bg-white/[0.02]"}`}
                    >
                      {row.local
                        ? <HardDrive size={13} className="text-zinc-500 shrink-0" />
                        : <Cloud size={13} className="text-primary/70 shrink-0" />}
                      <span className="flex-1 min-w-0 truncate text-[13.5px] text-zinc-100">{row.name}</span>
                      <StatusChip row={row} />
                      <ChevronDown size={13} className={`text-zinc-600 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>

                    {open && (
                      <div className="px-3 pb-3 pt-1 bg-black/20 space-y-2.5 animate-in fade-in">
                        {row.local ? (
                          <>
                            <div className="flex gap-2">
                              {/* min-w-0: an input won't shrink below its intrinsic
                                  width, which pushed the Open button out of the card on phones. */}
                              <SecretInput
                                ref={passwordInputRef}
                                value={password}
                                onChange={(v) => { setPassword(v); setUnlockError(null); }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") unlockSelected();
                                  // Escape clears a typed password and its error.
                                  if (e.key === "Escape" && (password || unlockError)) {
                                    e.preventDefault();
                                    setPassword("");
                                    setUnlockError(null);
                                  }
                                }}
                                placeholder="Password"
                                autoComplete="current-password"
                                invalid={!!unlockError}
                                describedBy={unlockError || capsLock ? "unlock-hint" : undefined}
                                wrapperClassName="relative min-w-0 flex-1"
                                className={withInvalid(
                                  "w-full h-10 pl-3.5 bg-zinc-900/50 border border-white/5 rounded-lg text-[13.5px] text-zinc-50 placeholder:text-zinc-600 outline-none focus:border-primary/50 transition-colors",
                                  !!unlockError,
                                )}
                              />
                              <button
                                onClick={unlockSelected}
                                disabled={busy || !password}
                                title="Open"
                                className="h-10 px-3.5 rounded-lg text-[13px] font-semibold bg-primary text-black hover:shadow-[0_0_20px_rgba(var(--primary),0.3)] disabled:opacity-40 flex items-center gap-1.5 shrink-0 transition-all"
                              >
                                {busy ? <RefreshCw size={14} className="animate-spin" /> : <>Open <ArrowRight size={14} /></>}
                              </button>
                            </div>
                            {(unlockError || capsLock) && (
                              <div id="unlock-hint" aria-live="polite">
                                {unlockError
                                  ? <FieldHint tone="error">{unlockError}</FieldHint>
                                  : <FieldHint tone="warn">Caps Lock is on</FieldHint>}
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-1.5">
                              <RowAction onClick={() => exportProfile(row.name)} disabled={busy} icon={<Download size={12} />} label="Export" />
                              <RowAction onClick={() => removeLocal(row.name)} disabled={busy} icon={<Trash2 size={12} />} label="Remove local" danger />
                              {row.cloud && (
                                <RowAction onClick={() => deleteFromCloud(row)} disabled={busy} icon={<CloudOff size={12} />} label="Delete from cloud" danger />
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-[11.5px] text-zinc-400 leading-snug">
                              Not on this device yet · {row.cloud!.live_records} item{row.cloud!.live_records === 1 ? "" : "s"}.
                              Get it with this profile's password.
                            </p>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => bringDown(row.cloud!)}
                                disabled={busy}
                                className="flex-1 h-9 rounded-lg text-[12.5px] font-semibold bg-primary/10 border border-primary/30 text-primary hover:bg-primary hover:text-black disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
                              >
                                <Download size={13} /> Get on this device
                              </button>
                              <RowAction onClick={() => deleteFromCloud(row)} disabled={busy} icon={<CloudOff size={12} />} label="Delete" danger />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2 pt-0.5">
              <button
                onClick={openCreate}
                className="flex-1 h-9 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/5 hover:border-white/10 text-zinc-400 hover:text-zinc-100 text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus size={12} /> New profile
              </button>
              <button
                onClick={startImport}
                disabled={busy}
                title="Import an exported .submarine file"
                className="flex-1 h-9 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/5 hover:border-white/10 text-zinc-400 hover:text-zinc-100 text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Upload size={12} /> Import
              </button>
            </div>
          </div>
        )}

        {/* Cloud status bar — always visible. Signed-out shows a Connect
            link; signed-in shows the account email + a way into Manage. */}
        <CloudBar status={cloudStatus} busy={busy} onManage={() => setCloudOpen(true)} />

        {/* GitHub, the update check and the running version side by side,
            with a live "new version" notice underneath when one is available
            (the check steps aside then - the notice says it all). */}
        <div className="mt-4 flex flex-col items-center gap-2.5">
          <div aria-live="polite" className="flex flex-wrap items-center justify-center gap-1 text-[11.5px]">
            <FooterButton onClick={openRepo} title="Open Submarine on GitHub" icon={<GithubIcon size={12} />} label="GitHub" />
            {!update && (
              <>
                <FooterDot />
                <FooterButton
                  onClick={checkForUpdates}
                  disabled={check === "checking"}
                  title={check === "error" ? `Couldn't reach GitHub: ${checkError}` : "Look for a newer release on GitHub"}
                  icon={checkItem.icon}
                  label={checkItem.label}
                  tone={checkItem.tone}
                />
              </>
            )}
            {appInfo && (
              <>
                <FooterDot />
                <span className="px-1.5 font-mono text-[11px] text-zinc-600 select-text">v{appInfo.version}</span>
              </>
            )}
          </div>
          {/* Why a check or a link failed - as text, since a phone can't
              hover the tooltip. */}
          {(linkError || (check === "error" && checkError)) && (
            <p role="status" className="max-w-[320px] text-center text-[10.5px] leading-snug text-amber-400/80 break-words">
              {linkError || `Couldn't reach GitHub: ${checkError}`}
            </p>
          )}
          {update?.has_update && update.latest && (
            <button
              onClick={openReleaseNotes}
              title="Open the release notes on GitHub"
              className="group flex items-center gap-1.5 text-[10.5px] text-primary/90 hover:text-primary animate-in fade-in slide-in-from-bottom-1 duration-700"
            >
              {/* pulsing dot — the "something new" signal */}
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <ArrowUpCircle size={11} className="shrink-0" />
              <span>New version <span className="font-mono font-semibold">v{update.latest}</span> available</span>
              <span className="opacity-60 transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          )}
        </div>
      </div>

      <CloudPanel
        isOpen={cloudOpen}
        onClose={() => {
          setCloudOpen(false);
          // The modal may have logged in/out or changed cloud state —
          // re-pull so the bar (and profile list) reflects reality.
          refreshCloud();
        }}
        onLocalProfilesChanged={reload}
      />
    </div>
  );
};

// Small pill telling you where a profile lives at a glance.
const StatusChip = ({ row }: { row: Row }) => {
  const base = "inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-[9.5px] font-semibold uppercase tracking-wide border shrink-0";
  if (row.local && row.cloud)
    return <span className={`${base} text-emerald-300 bg-emerald-500/10 border-emerald-500/20`}><CheckCircle2 size={10} /> Synced</span>;
  if (row.local)
    return <span className={`${base} text-zinc-400 bg-white/[0.04] border-white/10`}><HardDrive size={10} /> This device</span>;
  return <span className={`${base} text-primary bg-primary/10 border-primary/25`}><Cloud size={10} /> In cloud</span>;
};

// A compact secondary action inside an expanded row.
const RowAction = ({
  onClick, disabled, icon, label, danger,
}: {
  onClick: () => void; disabled?: boolean; icon: React.ReactNode; label: string; danger?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    className={`h-7 px-2 rounded-md text-[11px] font-medium border flex items-center gap-1 disabled:opacity-40 transition-colors ${
      danger
        ? "text-rose-300/90 bg-rose-500/5 border-rose-500/15 hover:bg-rose-500/15 hover:text-rose-200"
        : "text-zinc-400 bg-white/[0.03] border-white/10 hover:bg-white/[0.07] hover:text-zinc-100"
    }`}
  >
    {icon} {label}
  </button>
);

// lucide-react 1.0 dropped all brand icons; this is the ISC-licensed
// `github` outline it used to ship, kept inline so the footer keeps its look.
function GithubIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

// A low-key text button for the footer row under the cloud bar.
const FooterButton = ({
  onClick, disabled, title, icon, label, tone,
}: {
  onClick: () => void; disabled?: boolean; title: string; icon: React.ReactNode; label: string; tone?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`h-7 px-2 rounded-md flex items-center gap-1.5 transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-transparent ${
      tone || "text-zinc-500 hover:text-zinc-200"
    }`}
  >
    {icon} {label}
  </button>
);

const FooterDot = () => <span aria-hidden className="text-zinc-700 select-none">·</span>;

const CloudBar = ({
  status, busy, onManage,
}: {
  status: CloudStatus;
  busy: boolean;
  onManage: () => void;
}) => {
  // Signed-out: a thin, low-weight link rather than a fourth full-width
  // button — the user hasn't asked for cloud yet, so we don't want it
  // competing visually with the profile list.
  if (!status.signed_in) {
    return (
      <button
        onClick={onManage}
        className="mt-4 h-7 mx-auto text-[11.5px] text-zinc-500 hover:text-primary transition-colors flex items-center justify-center gap-1.5"
      >
        <Cloud size={11} /> Connect cloud sync
      </button>
    );
  }
  return (
    <div className="mt-4 h-9 px-2.5 rounded-lg border border-white/5 bg-white/[0.02] flex items-center gap-2 text-[11.5px]">
      <Cloud size={12} className="text-primary shrink-0" />
      <span className="text-zinc-300 truncate font-mono flex-1 min-w-0">{status.email}</span>
      <span className="text-emerald-400 flex items-center gap-1 shrink-0">
        <CheckCircle2 size={11} /> Connected
      </span>
      <button
        onClick={onManage}
        disabled={busy}
        title="Manage cloud account"
        className="text-zinc-500 hover:text-primary disabled:opacity-50 shrink-0 p-0.5"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
    </div>
  );
};

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: "current-password" | "new-password";
  className: string;
  wrapperClassName?: string;
  invalid?: boolean;
  describedBy?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

// A password box with a show / hide toggle, hidden at first. Shown or not, it
// stays out of spell check and autocorrect, so a visible password isn't kept
// as a word. The ref is the input, so a wrong password can be selected.
const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  ({ value, onChange, placeholder, autoComplete, className, wrapperClassName, invalid = false, describedBy, onKeyDown }, ref) => {
    const [shown, setShown] = useState(false);
    return (
      <div className={wrapperClassName ?? "relative w-full"}>
        <input
          ref={ref}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`pr-10 ${className}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          // Keeps the focus, and the caret, in the box.
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Show password"
          aria-pressed={shown}
          title={shown ? "Hide password" : "Show password"}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/5 flex items-center justify-center"
        >
          {shown ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    );
  },
);
SecretInput.displayName = "SecretInput";

// A line under a box: a problem, or a warning such as Caps Lock.
const FieldHint = ({ id, tone, children }: { id?: string; tone: "error" | "warn"; children: React.ReactNode }) => (
  <p
    id={id}
    className={`mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug ${tone === "error" ? "text-rose-300" : "text-amber-300/90"}`}
  >
    {tone === "error"
      ? <AlertTriangle size={13} className="mt-px shrink-0" />
      : <ArrowBigUp size={13} className="mt-px shrink-0" />}
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

// A password rule, ticked once it's met. Grey until a Create click, then red
// if still missing.
const Rule = ({ ok, strict, children }: { ok: boolean; strict: boolean; children: React.ReactNode }) => (
  <li className={`flex items-center gap-1.5 text-[12px] transition-colors ${ok ? "text-emerald-400" : strict ? "text-rose-300" : "text-zinc-500"}`}>
    <span
      aria-hidden
      className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${
        ok ? "border-emerald-400/60 bg-emerald-400/15" : strict ? "border-rose-400/50" : "border-zinc-600"
      }`}
    >
      {ok && <Check size={9} strokeWidth={3} />}
    </span>
    <span className="sr-only">{ok ? "Done: " : "Needed: "}</span>
    {children}
  </li>
);

export default ProfileSelectPage;
