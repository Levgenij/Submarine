//! A copy of a profile as it was, kept before a sync that deletes rows from it.
//!
//! A tombstone from the sync server is `{uuid, type, stamp, deleted}`: nothing
//! in it proves who sent it (the real fix is to authenticate them, which the
//! sync protocol doesn't do yet). A compromised server, or anyone holding the
//! account's token, can therefore delete every server, login and key of a
//! personal profile at the next sync, and the merge is then saved over the only
//! copy. Until deletions are authenticated, the sync that is about to delete
//! rows first keeps the profile file as it stood: `<name>.submarine.bak-<unix
//! time>`, next to it. The name doesn't end in `.submarine`, so the profile
//! list doesn't show it.
//!
//! Renaming a copy back by hand isn't enough: the deletions are still on the
//! server with newer stamps, so the next sync would make them again. The
//! profile picker's menu puts a copy back with `put_back`, which also leaves a
//! mark next to the file: the first sync after it keeps those rows and sends
//! them out again (`keep_put_back_rows` in lib.rs).
//!
//! Best effort by design: a backup that can't be made never stops a sync.

use std::fs;
use std::path::{Path, PathBuf};

/// How many backups of one profile are kept: the newest ones.
pub const KEEP: usize = 5;
/// A new backup is made only when the newest is older than this. Without it,
/// a stream of one-row deletions would push the good copy out of the five;
/// with it, the first copy stays while the others are made at this pace.
pub const MIN_GAP_SECS: u64 = 10 * 60;

fn stem(vault: &Path) -> Option<String> {
    Some(format!("{}.bak-", vault.file_name()?.to_str()?))
}

/// The backups of `vault` that exist, oldest first, with the time in their name.
fn existing(vault: &Path) -> Vec<(u64, PathBuf)> {
    let (Some(dir), Some(stem)) = (vault.parent(), stem(vault)) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let when = name.strip_prefix(&stem)?.parse::<u64>().ok()?;
            Some((when, e.path()))
        })
        .collect();
    found.sort();
    found
}

/// Whole or not at all: a half copy is never taken for a backup, or for the
/// profile.
fn copy_whole(from: &Path, to: &Path) -> Result<(), String> {
    let name = to.file_name().and_then(|n| n.to_str()).ok_or("[BACKUP] NAME")?;
    let tmp = to.with_file_name(format!("{name}.tmp"));
    if let Err(e) = fs::copy(from, &tmp).and_then(|_| fs::rename(&tmp, to)) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("[BACKUP] COPY: {e}"));
    }
    Ok(())
}

/// Copies `vault` to a new backup, unless there is no file yet or the newest
/// backup is younger than `MIN_GAP_SECS`; then removes all but the newest
/// `KEEP`. A backup dated ahead of `now_unix` counts as the oldest, for both.
/// Returns the new backup's file name when one was made.
pub fn keep(vault: &Path, now_unix: u64) -> Result<Option<String>, String> {
    if !vault.is_file() {
        return Ok(None);
    }
    let have = existing(vault);
    // Copies dated in the future (the clock went back) don't count: they must not block new ones.
    if have.iter().rev().find(|(when, _)| *when <= now_unix).is_some_and(|(when, _)| now_unix - *when < MIN_GAP_SECS) {
        return Ok(None);
    }
    let name = format!("{}{now_unix:010}", stem(vault).ok_or("[BACKUP] NAME")?);
    copy_whole(vault, &vault.with_file_name(&name))?;
    // A copy dated ahead of now was made before the clock went back: it is
    // really older than any other, and the one just made is the newest.
    let mut all = existing(vault);
    all.sort_by_key(|(when, _)| (*when <= now_unix, *when));
    while all.len() > KEEP {
        let (_, oldest) = all.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(Some(name))
}

/// One kept copy, as the profile picker lists it.
#[derive(serde::Serialize)]
pub struct KeptCopy {
    pub file: String,
    /// When it was made, in Unix seconds.
    pub when: u64,
}

/// The copies kept of `vault`, newest first.
pub fn list(vault: &Path) -> Vec<KeptCopy> {
    existing(vault)
        .into_iter()
        .rev()
        .filter_map(|(when, path)| Some(KeptCopy { file: path.file_name()?.to_str()?.to_string(), when }))
        .collect()
}

/// The mark `put_back` leaves next to `vault`, until a sync has dealt with it.
fn put_back_mark(vault: &Path) -> Option<PathBuf> {
    Some(vault.with_file_name(format!("{}.put-back", vault.file_name()?.to_str()?)))
}

/// A kept copy was put back as `vault`, and no sync has run since.
pub fn is_put_back(vault: &Path) -> bool {
    put_back_mark(vault).is_some_and(|m| m.is_file())
}

/// Forgets that mark: a sync has dealt with it, or the profile is gone.
pub fn clear_put_back(vault: &Path) {
    if let Some(mark) = put_back_mark(vault) {
        let _ = fs::remove_file(mark);
    }
}

/// Makes the kept copy `file` the profile again. What the profile holds now
/// is kept as a copy too, so the wrong choice can be undone the same way.
/// `file` has to be one of this profile's own copies: it comes from the page.
/// Only the vault and the put-back mark change: a foreign-profile marker
/// (`.submarine.imported`) stays as it is, since the copy is the same profile.
pub fn put_back(vault: &Path, file: &str, now_unix: u64) -> Result<(), String> {
    let have = existing(vault);
    let (_, copy) = have
        .iter()
        .find(|(_, p)| p.file_name().and_then(|n| n.to_str()) == Some(file))
        .ok_or("[BACKUP] NO_SUCH_COPY: that copy isn't there any more.")?;
    if vault.is_file() {
        // A name of its own: two in one second must not replace a copy.
        let free = (now_unix..).find(|t| have.iter().all(|(when, _)| when != t)).unwrap_or(now_unix);
        let name = format!("{}{free:010}", stem(vault).ok_or("[BACKUP] NAME")?);
        copy_whole(vault, &vault.with_file_name(name))?;
    }
    // The mark first: a copy put back without it would lose its rows again.
    let mark = put_back_mark(vault).ok_or("[BACKUP] NAME")?;
    // One left by an earlier put-back that no sync has dealt with yet stays,
    // whatever happens here.
    let had_mark = mark.is_file();
    fs::write(&mark, b"").map_err(|e| format!("[BACKUP] MARK: {e}"))?;
    if let Err(e) = copy_whole(copy, vault) {
        if !had_mark {
            let _ = fs::remove_file(&mark);
        }
        return Err(e);
    }
    Ok(())
}

/// Removes every backup of `vault`, and half-written `.tmp` copies of one, and
/// the put-back mark: a deleted profile leaves no copies behind. Best effort,
/// like the rest.
pub fn forget(vault: &Path) {
    clear_put_back(vault);
    for (_, path) in existing(vault) {
        let _ = fs::remove_file(path);
    }
    let (Some(dir), Some(stem)) = (vault.parent(), stem(vault)) else {
        return;
    };
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&stem) && name.ends_with(".tmp") {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("submarine-vault-backup-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_profile_as_it_was_is_kept_next_to_it() {
        let dir = temp_dir("kept");
        let vault = dir.join("work.submarine");
        fs::write(&vault, b"the vault before the sync").unwrap();
        let name = keep(&vault, 1_000_000_000).unwrap().expect("a backup is made");
        assert_eq!(name, "work.submarine.bak-1000000000");
        assert_eq!(fs::read(dir.join(&name)).unwrap(), b"the vault before the sync");
        // The profile list takes files that end in .submarine only.
        assert!(!name.ends_with(".submarine"));
        // No half-copy is left lying around.
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_to_copy_is_no_error() {
        let dir = temp_dir("none");
        assert_eq!(keep(&dir.join("gone.submarine"), 1_000_000_000).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stream_of_deleting_syncs_doesnt_push_the_first_copy_out() {
        let dir = temp_dir("gap");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"all there").unwrap();
        let t0 = 2_000_000_000u64;
        assert!(keep(&vault, t0).unwrap().is_some());
        fs::write(&vault, b"one gone").unwrap();
        // A sync a minute, each deleting a row: no new copy until the first is old enough.
        for minute in 1..MIN_GAP_SECS / 60 {
            assert_eq!(keep(&vault, t0 + minute * 60).unwrap(), None, "minute {minute}");
        }
        assert!(keep(&vault, t0 + MIN_GAP_SECS).unwrap().is_some());
        let have = existing(&vault);
        assert_eq!(have.len(), 2);
        assert_eq!(fs::read(&have[0].1).unwrap(), b"all there", "the first copy is still the oldest");
        assert_eq!(fs::read(&have[1].1).unwrap(), b"one gone");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_newest_few_are_kept_and_other_profiles_are_left_alone() {
        let dir = temp_dir("rotate");
        let vault = dir.join("p.submarine");
        let other = dir.join("q.submarine");
        fs::write(&vault, b"p").unwrap();
        fs::write(&other, b"q").unwrap();
        keep(&other, 3_000_000_000).unwrap();
        for i in 0..(KEEP as u64 + 3) {
            fs::write(&vault, format!("version {i}")).unwrap();
            assert!(keep(&vault, 3_000_000_000 + i * (MIN_GAP_SECS + 1)).unwrap().is_some());
        }
        let have = existing(&vault);
        assert_eq!(have.len(), KEEP);
        // The newest ones: versions 3 to 7.
        assert_eq!(fs::read(&have[0].1).unwrap(), b"version 3");
        assert_eq!(fs::read(&have[KEEP - 1].1).unwrap(), b"version 7");
        assert_eq!(existing(&other).len(), 1, "another profile's backup is not touched");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backup_from_the_future_doesnt_stop_a_new_one() {
        let dir = temp_dir("future");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        assert!(keep(&vault, 5_000_000_000).unwrap().is_some());
        // The clock went back a day: the newest copy is dated ahead of now.
        assert!(keep(&vault, 5_000_000_000 - 86_400).unwrap().is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_copy_just_made_is_not_the_one_pruned() {
        let dir = temp_dir("future-full");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        let now = 7_000_000_000u64;
        for i in 0..KEEP as u64 {
            fs::write(dir.join(format!("p.submarine.bak-{:010}", now + 1000 + i)), b"old").unwrap();
        }
        let name = keep(&vault, now).unwrap().expect("a backup is made");
        assert!(dir.join(&name).exists(), "the new copy survives");
        assert_eq!(existing(&vault).len(), KEEP);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_dated_ahead_go_before_real_ones() {
        let dir = temp_dir("future-prune");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        let now = 9_000_000_000u64;
        for i in 0..KEEP as u64 {
            fs::write(dir.join(format!("p.submarine.bak-{:010}", now + 100_000 + i)), b"old").unwrap();
        }
        let first = keep(&vault, now).unwrap().expect("a backup is made");
        let second = keep(&vault, now + MIN_GAP_SECS).unwrap().expect("a backup is made");
        assert!(dir.join(&first).exists(), "the earlier real copy stays");
        assert!(dir.join(&second).exists(), "the new copy stays");
        assert_eq!(existing(&vault).len(), KEEP);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_future_backup_doesnt_switch_off_the_gap() {
        let dir = temp_dir("future-gap");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        let now = 8_000_000_000u64;
        fs::write(dir.join(format!("p.submarine.bak-{:010}", now + 1000)), b"future").unwrap();
        fs::write(dir.join(format!("p.submarine.bak-{:010}", now - 60)), b"recent").unwrap();
        assert_eq!(keep(&vault, now).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_a_profile_removes_its_half_written_copy_too() {
        let dir = temp_dir("forget-tmp");
        let vault = dir.join("p.submarine");
        let other = dir.join("p2.submarine");
        fs::write(&vault, b"p").unwrap();
        fs::write(&other, b"p2").unwrap();
        keep(&other, 6_000_000_000).unwrap();
        let leftover = dir.join("p.submarine.bak-6000000000.tmp");
        let others_tmp = dir.join("p2.submarine.bak-6000000000.tmp");
        fs::write(&leftover, b"half").unwrap();
        fs::write(&others_tmp, b"half").unwrap();
        forget(&vault);
        assert!(!leftover.exists());
        assert!(others_tmp.exists(), "another profile's leftover is not touched");
        assert_eq!(existing(&other).len(), 1, "another profile's backup is not touched");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_a_profile_removes_its_backups_only() {
        let dir = temp_dir("forget");
        let vault = dir.join("p.submarine");
        let other = dir.join("p2.submarine");
        fs::write(&vault, b"p").unwrap();
        fs::write(&other, b"p2").unwrap();
        keep(&vault, 4_000_000_000).unwrap();
        keep(&other, 4_000_000_000).unwrap();
        forget(&vault);
        assert!(existing(&vault).is_empty());
        assert_eq!(existing(&other).len(), 1, "p2's backup is not p's");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_are_listed_newest_first() {
        let dir = temp_dir("list");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        keep(&vault, 3_000_000_000).unwrap();
        keep(&vault, 3_000_000_000 + MIN_GAP_SECS).unwrap();
        // A half-made copy isn't one.
        fs::write(dir.join("p.submarine.bak-4000000000.tmp"), b"half").unwrap();
        let listed: Vec<(String, u64)> = list(&vault).into_iter().map(|c| (c.file, c.when)).collect();
        assert_eq!(
            listed,
            vec![
                ("p.submarine.bak-3000000600".to_string(), 3_000_000_600),
                ("p.submarine.bak-3000000000".to_string(), 3_000_000_000),
            ]
        );
        assert!(list(&dir.join("q.submarine")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    // The copy becomes the profile, what was there stays as a copy, and the
    // mark tells the next sync what happened, until it has dealt with it.
    #[test]
    fn a_copy_put_back_is_the_profile_again_and_marked() {
        let dir = temp_dir("back");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"all there").unwrap();
        let name = keep(&vault, 3_000_000_000).unwrap().unwrap();
        fs::write(&vault, b"rows gone").unwrap();
        assert!(!is_put_back(&vault));

        put_back(&vault, &name, 3_000_000_100).unwrap();
        assert_eq!(fs::read(&vault).unwrap(), b"all there");
        assert_eq!(fs::read(dir.join("p.submarine.bak-3000000100")).unwrap(), b"rows gone");
        assert_eq!(fs::read(dir.join(&name)).unwrap(), b"all there", "the copy stays a copy");
        assert!(is_put_back(&vault));
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        clear_put_back(&vault);
        assert!(!is_put_back(&vault));
        let _ = fs::remove_dir_all(&dir);
    }

    // Two in one second: neither copy goes.
    #[test]
    fn putting_back_never_writes_over_a_copy() {
        let dir = temp_dir("same-second");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"first").unwrap();
        let name = keep(&vault, 3_000_000_000).unwrap().unwrap();
        fs::write(&vault, b"second").unwrap();
        put_back(&vault, &name, 3_000_000_000).unwrap();
        assert_eq!(fs::read(dir.join(&name)).unwrap(), b"first");
        assert_eq!(fs::read(dir.join("p.submarine.bak-3000000001")).unwrap(), b"second");
        let _ = fs::remove_dir_all(&dir);
    }

    // The name comes from the page: only this profile's own copies count, so
    // no other file of the folder can become the profile.
    #[test]
    fn only_this_profiles_own_copies_can_be_put_back() {
        let dir = temp_dir("own");
        let vault = dir.join("p.submarine");
        let other = dir.join("q.submarine");
        fs::write(&vault, b"p").unwrap();
        fs::write(&other, b"q").unwrap();
        keep(&other, 3_000_000_000).unwrap();
        keep(&vault, 3_000_000_001).unwrap();
        fs::write(&vault, b"p now").unwrap();
        for bad in ["q.submarine.bak-3000000000", "q.submarine", "../q.submarine", "p.submarine", ""] {
            assert!(put_back(&vault, bad, 3_000_000_100).is_err(), "{bad:?}");
        }
        assert_eq!(fs::read(&vault).unwrap(), b"p now");
        assert!(!is_put_back(&vault));
        assert_eq!(list(&vault).len(), 1, "and no copy was made of what's there");
        let _ = fs::remove_dir_all(&dir);
    }

    // A put back that fails undoes its own mark only: one from an earlier
    // put-back that no sync has dealt with yet is still needed.
    #[test]
    fn a_failed_put_back_leaves_an_earlier_mark_and_makes_none() {
        let dir = temp_dir("failed");
        let vault = dir.join("p.submarine");
        fs::write(&vault, b"p").unwrap();
        let name = keep(&vault, 3_000_000_000).unwrap().unwrap();
        // A directory where the profile goes: the copy can't be placed there.
        fs::remove_file(&vault).unwrap();
        fs::create_dir(&vault).unwrap();

        assert!(put_back(&vault, &name, 3_000_000_100).is_err());
        assert!(!is_put_back(&vault), "no mark of its own is left");

        fs::write(dir.join("p.submarine.put-back"), b"").unwrap();
        assert!(put_back(&vault, &name, 3_000_000_100).is_err());
        assert!(is_put_back(&vault), "an earlier mark stays");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_a_profile_removes_its_put_back_mark_too() {
        let dir = temp_dir("forget-mark");
        let vault = dir.join("p.submarine");
        let other = dir.join("p2.submarine");
        fs::write(&vault, b"p").unwrap();
        fs::write(&other, b"p2").unwrap();
        let name = keep(&vault, 4_000_000_000).unwrap().unwrap();
        put_back(&vault, &name, 4_000_000_100).unwrap();
        let other_name = keep(&other, 4_000_000_000).unwrap().unwrap();
        put_back(&other, &other_name, 4_000_000_100).unwrap();
        forget(&vault);
        assert!(!is_put_back(&vault));
        assert!(is_put_back(&other), "another profile's mark is not touched");
        let _ = fs::remove_dir_all(&dir);
    }
}
