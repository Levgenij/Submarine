// Archive / extract for the two file panels.
//
// Local side: written and read in-process with the `zip` / `tar` / `flate2`
// crates, so it works the same on every desktop OS and on Android.
// Remote side: `tar` / `zip` / `unzip` run on the server through an exec
// channel. Packing there means the data never crosses the wire; the cost is
// that the server needs those tools (`tar` practically always is there,
// `zip` / `unzip` often are not, and the error says so).
//
// Extraction never trusts the archive, and never writes through a link that
// is already in the destination. Both sides unpack into a fresh staging
// folder and move the result into place with a merge that refuses to go
// through a link. Locally the crates refuse entries that would land outside
// the staging folder, and the staged tree is checked for links pointing out
// of it (see `extract_local`). Remotely nothing is assumed about the server's
// `tar` / `unzip`, so the listing is checked before anything is unpacked
// (see `extract_script`).
//
// A new archive is written to a temporary `<name>.<unique>.part` next to the
// target and renamed into place at the end, so a failed run never leaves a
// half-written archive under the final name and never destroys the one it
// was going to replace. The temporary name is never taken from an existing
// file: if it is somehow there, the run fails instead of overwriting it.

use crate::ssh_manager::SshState;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Remote packing of a big tree is slow; this only bounds a hung command.
/// A watchdog in the script kills the tool on the server at this limit; our
/// own wait is a little longer so the script's report still arrives.
pub(crate) const REMOTE_TIMEOUT_SECS: u64 = 60 * 60;
const REMOTE_WAIT_SLACK_SECS: u64 = 60;
/// Exit code the script reports for a tool it stopped at the time limit, as
/// `timeout(1)` does. Not 143: that is any SIGTERM, not only the watchdog's.
const KILLED_BY_WATCHDOG: i32 = 124;
/// What a cancelled job fails with. The pane shows it as "Cancelled".
const CANCELLED: &str = "CANCELLED";
/// How long a cancelled remote job gets to stop its tool and clean up before
/// the channel is closed on it.
const CANCEL_GRACE_SECS: u64 = 20;
/// How much of a remote job's output is kept, from its end.
const OUTPUT_TAIL: usize = 8 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    Zip,
    Tar,
    TarGz,
}

fn parse_format(format: &str) -> Result<Format, String> {
    match format {
        "zip" => Ok(Format::Zip),
        "tar" => Ok(Format::Tar),
        "tar.gz" => Ok(Format::TarGz),
        other => Err(format!("Unsupported archive format: {}", other)),
    }
}

/// Archive type by file name. Mirrors `archiveKind` in `src/fs/archive.ts`.
fn format_of_name(name: &str) -> Option<Format> {
    let lower = name.to_lowercase();
    if lower.ends_with(".zip") {
        Some(Format::Zip)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some(Format::TarGz)
    } else if lower.ends_with(".tar") {
        Some(Format::Tar)
    } else {
        None
    }
}

// Extraction is addressed as "archive `name` in `dir`, into `dir` or its
// subfolder `folder`". Both are single path components, so neither the
// archive nor the destination can be steered out of `dir` with `../` or a
// separator, whatever a directory listing claimed the entry was called.
fn check_extract_names(name: &str, folder: Option<&str>) -> Result<Format, String> {
    if !crate::is_safe_dir_entry_name(name) {
        return Err(format!("Invalid archive name: {}", name));
    }
    if let Some(folder) = folder {
        if !is_plain_folder_name(folder) {
            return Err(format!("Invalid folder name: {}", folder));
        }
    }
    format_of_name(name).ok_or_else(|| "Not a zip or tar archive".to_string())
}

// A folder to create. On top of being one path component it must not start
// or end with whitespace or end with a dot: Windows drops trailing spaces and
// dots when it creates a directory, which turns ".. " and "..." into the
// parent or the current folder. Mirrors `extractFolderName` in archive.ts.
fn is_plain_folder_name(folder: &str) -> bool {
    folder_name_ok(folder, crate::is_safe_dir_entry_name)
}

/// One name on a server: a single POSIX path component, whatever OS this
/// client runs on. `\` and `:` are ordinary characters there; a name that
/// would climb where `\` is a separator is still refused.
fn remote_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0')
        && !name.split('\\').any(|step| step == "..")
}

fn folder_name_ok(folder: &str, name_ok: fn(&str) -> bool) -> bool {
    name_ok(folder) && folder == folder.trim() && !folder.ends_with('.')
}

fn check_remote_names(names: &[String]) -> Result<(), String> {
    if names.is_empty() {
        return Err("Nothing to archive".into());
    }
    match names.iter().find(|n| !remote_name_ok(n)) {
        Some(bad) => Err(format!("Invalid item name: {}", bad)),
        None => Ok(()),
    }
}

fn check_remote_extract(name: &str, folder: Option<&str>) -> Result<Format, String> {
    if !remote_name_ok(name) {
        return Err(format!("Invalid archive name: {}", name));
    }
    if let Some(folder) = folder {
        if !folder_name_ok(folder, remote_name_ok) {
            return Err(format!("Invalid folder name: {}", folder));
        }
    }
    format_of_name(name).ok_or_else(|| "Not a zip or tar archive".to_string())
}

/// The last component of a remote archive path the pane chose.
fn check_remote_dest(dest: &str) -> Result<(), String> {
    let leaf = dest.rsplit(['/', '\\']).next().unwrap_or(dest);
    if remote_name_ok(leaf) {
        Ok(())
    } else {
        Err(format!("Invalid archive name: {}", leaf))
    }
}

// A symbolic link, or on Windows any other reparse point: a junction
// (`mklink /J`) redirects a folder just like a link does, and is followed by
// `canonicalize` and by every write below it.
fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

// Where a local extract lands. The folder's own entry is looked at before
// anything resolves it: the local listing shows a link to a folder as a plain
// folder, and `guard_local_path` canonicalizes, so without this "Extract to
// site/" would quietly unpack into whatever `site` points at. The remote
// script refuses the same case (`[ -L "$d" ]`).
fn local_extract_dest(base: &Path, folder: Option<&str>) -> Result<PathBuf, String> {
    let Some(folder) = folder else {
        return Ok(base.to_path_buf());
    };
    let target = base.join(folder);
    existing_dest_is_folder(&target, folder)?;
    Ok(target)
}

// Whether there is something at `target`; an error if it is a link or not a
// folder. Looks at the entry itself, never at what it resolves to.
fn existing_dest_is_folder(target: &Path, label: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(target) {
        Err(_) => Ok(false),
        Ok(meta) if is_link(&meta) => {
            Err(format!("{} is a link, not extracting through it", label))
        }
        Ok(meta) if !meta.is_dir() => Err(format!("{} exists and is not a folder", label)),
        Ok(_) => Ok(true),
    }
}

fn not_archivable(rel: &str) -> String {
    format!(
        "{}: not a file, folder or link (FIFO, socket or device), it cannot be archived",
        rel
    )
}

fn check_names(names: &[String]) -> Result<(), String> {
    if names.is_empty() {
        return Err("Nothing to archive".into());
    }
    match names.iter().find(|n| !crate::is_safe_dir_entry_name(n)) {
        Some(bad) => Err(format!("Invalid item name: {}", bad)),
        None => Ok(()),
    }
}

// ---- local ------------------------------------------------------------------

fn part_path(dest: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut s = dest.as_os_str().to_os_string();
    s.push(format!(".{}-{}.part", std::process::id(), nanos));
    PathBuf::from(s)
}

// Zip stores a calendar date, not a timestamp. Days-to-civil conversion after
// Howard Hinnant's `civil_from_days`; UTC, since std has no local offset.
fn zip_time(meta: &std::fs::Metadata) -> Option<zip::DateTime> {
    let secs = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    zip::DateTime::from_date_and_time(
        u16::try_from(year).ok()?,
        month as u8,
        day as u8,
        (rem / 3_600) as u8,
        (rem % 3_600 / 60) as u8,
        (rem % 60) as u8,
    )
    .ok()
}

fn zip_options(meta: &std::fs::Metadata) -> zip::write::SimpleFileOptions {
    let mut opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(meta.len() > u32::MAX as u64);
    if let Some(t) = zip_time(meta) {
        opts = opts.last_modified_time(t);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        opts = opts.unix_permissions(meta.permissions().mode());
    }
    opts
}

fn cancelled() -> String {
    CANCELLED.to_string()
}

fn stop_err(cancel: &AtomicBool, err: &str) -> String {
    if cancel.load(Ordering::Relaxed) {
        cancelled()
    } else {
        err.to_string()
    }
}

/// Fails the next read once the job is cancelled, so a long copy stops there.
struct CancelRead<'a, R> {
    inner: R,
    cancel: &'a AtomicBool,
}

impl<R: Read> Read for CancelRead<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other(CANCELLED));
        }
        self.inner.read(buf)
    }
}

impl<R: Seek> Seek for CancelRead<'_, R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other(CANCELLED));
        }
        self.inner.seek(pos)
    }
}

// `rel` is the name inside the archive, always with `/`. A symlink is stored
// as a link (like local tar and the remote `zip -y`), never followed: its
// target may lie outside the selection, and a link back up the tree would
// loop the walk. Anything that is not a file, folder or link (FIFO, socket,
// device) is refused: opening one can block forever.
fn zip_add<W: Write + Seek>(
    zw: &mut zip::ZipWriter<W>,
    abs: &Path,
    rel: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let meta = std::fs::symlink_metadata(abs).map_err(|e| format!("{}: {}", rel, e))?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        let target = std::fs::read_link(abs).map_err(|e| format!("{}: {}", rel, e))?;
        let target = target.to_string_lossy().replace('\\', "/");
        zw.add_symlink(rel, target, zip_options(&meta))
            .map_err(|e| format!("{}: {}", rel, e))?;
    } else if kind.is_dir() {
        zw.add_directory(rel, zip_options(&meta))
            .map_err(|e| format!("{}: {}", rel, e))?;
        let read_dir = std::fs::read_dir(abs).map_err(|e| format!("{}: {}", rel, e))?;
        for entry in read_dir {
            let entry = entry.map_err(|e| format!("{}: {}", rel, e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            zip_add(zw, &entry.path(), &format!("{}/{}", rel, name), cancel)?;
        }
    } else if !kind.is_file() {
        return Err(not_archivable(rel));
    } else {
        zw.start_file(rel, zip_options(&meta))
            .map_err(|e| format!("{}: {}", rel, e))?;
        let mut file = CancelRead {
            inner: std::fs::File::open(abs).map_err(|e| format!("{}: {}", rel, e))?,
            cancel,
        };
        std::io::copy(&mut file, zw).map_err(|e| stop_err(cancel, &format!("{}: {}", rel, e)))?;
    }
    Ok(())
}

// Same walk and the same rules as `zip_add`, so both formats refuse a FIFO
// instead of reading it. A link is stored as a link: the builder is told not
// to follow them.
fn tar_add<W: Write>(
    builder: &mut tar::Builder<W>,
    abs: &Path,
    rel: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let meta = std::fs::symlink_metadata(abs).map_err(|e| format!("{}: {}", rel, e))?;
    let kind = meta.file_type();
    if kind.is_symlink() || kind.is_file() {
        builder
            .append_path_with_name(abs, rel)
            .map_err(|e| format!("{}: {}", rel, e))?;
    } else if kind.is_dir() {
        builder
            .append_dir(rel, abs)
            .map_err(|e| format!("{}: {}", rel, e))?;
        let read_dir = std::fs::read_dir(abs).map_err(|e| format!("{}: {}", rel, e))?;
        for entry in read_dir {
            let entry = entry.map_err(|e| format!("{}: {}", rel, e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            tar_add(builder, &entry.path(), &format!("{}/{}", rel, name), cancel)?;
        }
    } else {
        return Err(not_archivable(rel));
    }
    Ok(())
}

fn tar_write<W: Write>(
    out: W,
    dir: &Path,
    names: &[String],
    cancel: &AtomicBool,
) -> Result<W, String> {
    let mut builder = tar::Builder::new(out);
    builder.follow_symlinks(false);
    for name in names {
        tar_add(&mut builder, &dir.join(name), name, cancel)?;
    }
    builder.into_inner().map_err(|e| e.to_string())
}

fn write_local_archive(
    dir: &Path,
    names: &[String],
    file: std::fs::File,
    format: Format,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let file = std::io::BufWriter::new(file);
    let mut file = match format {
        Format::Zip => {
            let mut zw = zip::ZipWriter::new(file);
            for name in names {
                zip_add(&mut zw, &dir.join(name), name, cancel)?;
            }
            zw.finish().map_err(|e| stop_err(cancel, &e.to_string()))?
        }
        Format::Tar => tar_write(file, dir, names, cancel)?,
        Format::TarGz => {
            let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            tar_write(gz, dir, names, cancel)?
                .finish()
                .map_err(|e| stop_err(cancel, &e.to_string()))?
        }
    };
    file.flush().map_err(|e| stop_err(cancel, &e.to_string()))
}

// Packs into `part`, then renames it onto `dest`. `create_new` fails on a
// file that is already there; that file is someone else's, so the cleanup
// below runs only once this call has created `part` itself.
fn pack_local(
    dir: &Path,
    names: &[String],
    part: &Path,
    dest: &Path,
    format: Format,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .map_err(|e| format!("Failed to create temporary file {}: {}", part.display(), e))?;
    let res = write_local_archive(dir, names, file, format, cancel).and_then(|()| {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        std::fs::rename(part, dest).map_err(|e| format!("Failed to save archive: {}", e))
    });
    if res.is_err() {
        let _ = std::fs::remove_file(part);
    }
    res
}

/// Packs `names` (entries of `dir`) into the archive `dest`. Fails with
/// `EXISTS:<path>` when `dest` is already there and `overwrite` is false.
#[tauri::command]
pub async fn local_archive(
    state: tauri::State<'_, SshState>,
    dir: String,
    names: Vec<String>,
    dest: String,
    format: String,
    overwrite: bool,
    job_id: String,
) -> Result<Option<String>, String> {
    let format = parse_format(&format)?;
    check_names(&names)?;
    // The working folder may be a drive root. The policy is about the archive
    // itself, and the last component is not resolved, so a link under that
    // name is replaced instead of written through.
    let safe_dir = local_work_dir(&dir)?;
    let safe_dest = crate::guard_local_path_nofollow(&dest, false)?;
    for name in &names {
        let src = crate::guard_local_path(&safe_dir.join(name).to_string_lossy(), false)?;
        if src == safe_dest {
            return Err(format!("{} is one of the items being archived", name));
        }
    }
    if let Some(meta) = name_is_present(&safe_dest) {
        if !overwrite {
            return Err(format!("EXISTS:{}", dest));
        }
        if meta.is_dir() && !is_link(&meta) {
            return Err("A folder with that name already exists".into());
        }
    }
    let (cancel, _job) = start_job(&state, &job_id).await?;
    let cancel_task = Arc::clone(&cancel);
    tokio::task::spawn_blocking(move || {
        pack_local(
            &safe_dir,
            &names,
            &part_path(&safe_dest),
            &safe_dest,
            format,
            &cancel_task,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(None)
}

/// A dangling symlink is present. `Path::exists` is false for one, which would
/// let a later write replace it or follow it.
fn name_is_present(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(path).ok()
}

/// A folder to pack or extract in. A drive root is allowed; system-folder
/// checks happen on the archive and on every path that gets written.
fn local_work_dir(dir: &str) -> Result<PathBuf, String> {
    let typed = crate::expand_bare_drive(dir);
    let path = Path::new(typed.as_ref());
    crate::require_full_path(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid folder: {}", e))?;
    if !canonical.is_dir() {
        return Err("Path is not a directory".into());
    }
    Ok(canonical)
}

fn unpack_local(
    archive: &Path,
    into: &Path,
    format: Format,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let file =
        std::fs::File::open(archive).map_err(|e| format!("Failed to open archive: {}", e))?;
    let reader = CancelRead {
        inner: std::io::BufReader::new(file),
        cancel,
    };
    let res = match format {
        Format::Zip => zip::ZipArchive::new(reader)
            .and_then(|mut z| z.extract(into))
            .map_err(|e| e.to_string()),
        Format::Tar => tar::Archive::new(reader)
            .unpack(into)
            .map_err(|e| e.to_string()),
        Format::TarGz => tar::Archive::new(flate2::read::GzDecoder::new(reader))
            .unpack(into)
            .map_err(|e| e.to_string()),
    };
    res.map_err(|e| stop_err(cancel, &format!("Extract failed: {}", e)))
}

// The crates keep every member inside the folder they unpack into, but a link
// member is created as the archive says, so `link -> ../secret` would be left
// pointing out of the destination. The remote side refuses such an archive as
// a whole; so does this, once the staged tree shows what it holds.
// A link target that stays inside the folder it is in: relative, and every
// component a real name. `Path::components` only calls a component exactly
// `..` the parent, but Win32 drops trailing spaces and dots when it opens a
// path, so `.. ` and `.. .` are the parent too (and `...` the folder itself).
// A component made only of dots and spaces is therefore never a real name.
fn link_target_inside(target: &Path) -> bool {
    target.components().all(|c| match c {
        std::path::Component::CurDir => true,
        std::path::Component::Normal(name) => !name
            .to_string_lossy()
            .chars()
            .all(|ch| ch == '.' || ch == ' '),
        _ => false,
    })
}

// A staged folder the merge has to move things out of, and the cleanup has
// to empty: a folder the archive made read-only allows neither, so it gets
// owner read, write and search.
fn make_usable(dir: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o700 != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode | 0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(unix))]
    {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            std::fs::set_permissions(dir, perms).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn drop_setid(path: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o6000 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & !0o6000))
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, meta);
    }
    Ok(())
}

// Walks the staged tree before anything of it is placed. Links that point
// outside the destination refuse the archive. Folders are made owner-writable
// on the way down, and setuid and setgid bits are dropped from files.
fn settle_staged(dir: &Path, rel: &str) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if meta.is_dir() && !is_link(&meta) {
        let label = if rel.is_empty() { "." } else { rel };
        make_usable(dir, &meta).map_err(|e| format!("{}: {}", label, e))?;
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if rel.is_empty() {
            name
        } else {
            format!("{}/{}", rel, name)
        };
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("{}: {}", rel, e))?;
        if is_link(&meta) {
            let target = std::fs::read_link(&path).map_err(|e| format!("{}: {}", rel, e))?;
            if !link_target_inside(&target) {
                return Err(format!(
                    "The archive has a link that points outside the destination: {}",
                    rel
                ));
            }
        } else if meta.is_dir() {
            settle_staged(&path, &rel)?;
        } else if meta.is_file() {
            drop_setid(&path, &meta).map_err(|e| format!("{}: {}", rel, e))?;
        } else {
            return Err(format!(
                "The archive has a special file (FIFO, socket or device): {}",
                rel
            ));
        }
    }
    Ok(())
}

// The root of a drive is a fine place to extract. Every other path goes
// through the same policy as any other local write.
fn refuse_system_write(path: &Path) -> Result<(), String> {
    if path.parent().is_none() {
        return Ok(());
    }
    crate::check_local_path_policy(path.to_path_buf()).map(|_| ())
}

fn check_staged_policy(stage: &Path, dest: &Path) -> Result<(), String> {
    refuse_system_write(dest)?;
    for entry in std::fs::read_dir(stage).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        refuse_system_write(&to)?;
        let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.is_dir() && !is_link(&meta) {
            check_staged_policy(&entry.path(), &to)?;
        }
    }
    Ok(())
}

fn remove_stage(stage: &Path) {
    fn usable(dir: &Path) {
        if let Ok(meta) = std::fs::symlink_metadata(dir) {
            if meta.is_dir() && !is_link(&meta) {
                let _ = make_usable(dir, &meta);
                if let Ok(read_dir) = std::fs::read_dir(dir) {
                    for entry in read_dir.flatten() {
                        usable(&entry.path());
                    }
                }
            }
        }
    }
    if std::fs::symlink_metadata(stage).is_ok() {
        usable(stage);
        let _ = std::fs::remove_dir_all(stage);
    }
}

// Moves the content of the staging folder `src` into the real folder `dst`.
// The Rust twin of `MERGE_FN` in the remote script: it runs once with
// `apply` false (only looks) and once with it true, so a refusal leaves the
// destination untouched. Same-named files are replaced; a link in a file's
// place is removed, not written through. A folder is merged into an existing
// folder and refused where the destination has a link or a file.
fn merge_staged(src: &Path, dst: &Path, rel: &str, apply: bool) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let rel = if rel.is_empty() {
            name.to_string_lossy().to_string()
        } else {
            format!("{}/{}", rel, name.to_string_lossy())
        };
        let from = entry.path();
        let to = dst.join(&name);
        let staged = std::fs::symlink_metadata(&from).map_err(|e| format!("{}: {}", rel, e))?;
        let existing = std::fs::symlink_metadata(&to).ok();
        let existing_link = existing.as_ref().map(is_link).unwrap_or(false);
        let existing_dir = existing
            .as_ref()
            .map(|m| m.is_dir() && !is_link(m))
            .unwrap_or(false);
        if staged.is_dir() && !is_link(&staged) {
            if existing_link {
                return Err(format!("{} is a link, not extracting through it", rel));
            } else if existing_dir {
                merge_staged(&from, &to, &rel, apply)?;
            } else if existing.is_some() {
                return Err(format!("{} is a file, the archive has a folder there", rel));
            } else if apply {
                std::fs::rename(&from, &to).map_err(|e| format!("{}: {}", rel, e))?;
            }
        } else if existing_dir {
            return Err(format!("{} is a folder, the archive has a file there", rel));
        } else if apply {
            if existing_link {
                // A link to a folder is removed as a folder on Windows.
                std::fs::remove_file(&to)
                    .or_else(|_| std::fs::remove_dir(&to))
                    .map_err(|e| format!("{}: {}", rel, e))?;
            }
            std::fs::rename(&from, &to).map_err(|e| format!("{}: {}", rel, e))?;
        }
    }
    Ok(())
}

// Unpacks `archive` into `dir` or its subfolder `folder`, by way of a staging
// folder this call has just created next to the destination: nothing in it is
// a link that was there before, so nothing is written through one.
fn extract_local(
    dir: &Path,
    archive: &Path,
    folder: Option<&str>,
    format: Format,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let dest = local_extract_dest(dir, folder)?;
    refuse_system_write(archive)?;
    refuse_system_write(&dest)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let stage = dir.join(format!(
        ".submarine-extract.{}-{}",
        std::process::id(),
        nanos
    ));
    refuse_system_write(&stage)?;
    // Not `create_dir_all`: a folder already under that name is not ours.
    std::fs::create_dir(&stage).map_err(|e| format!("Failed to create temporary folder: {}", e))?;
    let res = unpack_local(archive, &stage, format, cancel)
        .and_then(|()| settle_staged(&stage, ""))
        .and_then(|()| check_staged_policy(&stage, &dest))
        .and_then(|()| {
            if cancel.load(Ordering::Relaxed) {
                Err(cancelled())
            } else {
                Ok(())
            }
        })
        .and_then(|()| place_staged(&stage, &dest, folder.unwrap_or(".")));
    remove_stage(&stage);
    res
}

// Puts the staged tree at `dest`. The destination is looked at again here,
// not trusted from before the unpack: that can take long enough for a link
// or junction to appear under a name that was free, and the merge would then
// write `dest/child` through it. The remote script does the same
// (`[ -L "$d" ]` sits between its unpack and its merge).
fn place_staged(stage: &Path, dest: &Path, label: &str) -> Result<(), String> {
    if !existing_dest_is_folder(dest, label)? {
        return std::fs::rename(stage, dest).map_err(|e| format!("Failed to create folder: {}", e));
    }
    merge_staged(stage, dest, "", false)?;
    merge_staged(stage, dest, "", true)
}

/// Unpacks the archive `name` found in `dir`: into `dir` itself, or into its
/// subfolder `folder` (created if missing). Existing files with the same
/// names are replaced; see `extract_local` for what is refused.
#[tauri::command]
pub async fn local_extract(
    state: tauri::State<'_, SshState>,
    dir: String,
    name: String,
    folder: Option<String>,
    job_id: String,
) -> Result<Option<String>, String> {
    let format = check_extract_names(&name, folder.as_deref())?;
    // Resolved, but not refused for being a drive root. The archive path and
    // every extracted path still go through the system-folder policy.
    let base = local_work_dir(&dir)?;
    let archive = base.join(&name);
    let (cancel, _job) = start_job(&state, &job_id).await?;
    let cancel_task = Arc::clone(&cancel);
    tokio::task::spawn_blocking(move || {
        extract_local(&base, &archive, folder.as_deref(), format, &cancel_task)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(None)
}

// ---- remote -----------------------------------------------------------------

pub(crate) fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

const EXISTS_MARKER: &str = "__SUB_EXISTS";
const WARN_MARKER: &str = "__SUB_WARN";

// Runs `tool` in the background and leaves its exit code in `$rc`; a tool
// still running after `secs` is stopped (TERM, then KILL) and `$rc` is
// KILLED_BY_WATCHDOG.
//
// The timer only signals the script's own shell (`$$`; `run_remote` gives the
// script a shell of its own for that). The shell then stops the tool itself:
// the tool is its unreaped child, so that pid cannot have been handed to
// another process. The timer sleeps in short steps with its output on
// /dev/null, so after a normal finish it holds no pipe open and is gone
// within one step.
pub(crate) fn with_watchdog(tool: &str, secs: u64) -> String {
    format!(
        "timed=0; trap 'timed=1' USR1; {tool} & pid=$!; \
         ( n=0; while [ $n -lt {secs} ]; do sleep {step}; n=$((n+{step})); done; kill -USR1 $$ ) >/dev/null 2>&1 & dog=$!; \
         wait $pid; rc=$?; \
         if [ $timed -eq 1 ] && [ $rc -gt 128 ]; then \
         kill $pid 2>/dev/null; sleep 5; kill -9 $pid 2>/dev/null; wait $pid; rc={killed}; fi; \
         kill $dog 2>/dev/null",
        step = secs.clamp(1, 5),
        killed = KILLED_BY_WATCHDOG,
    )
}

fn format_word(format: Format) -> &'static str {
    match format {
        Format::Zip => "zip",
        Format::Tar => "tar",
        Format::TarGz => "tar.gz",
    }
}

/// Shell helpers for a job whose stdin stays open after the script is read.
/// Closing that stdin (Cancel, or the connection going away) stops the tool.
/// A separate timer still kills a tool that runs past `secs`.
fn job_fns(secs: u64) -> String {
    let step = secs.clamp(1, 5);
    format!(
        r#"job_init() {{
  exec 3<&0
  stop=0
  timed=0
  trap 'stop=1' USR2
  trap 'timed=1' USR1
  ( n=0; while [ "$n" -lt {secs} ]; do sleep {step}; n=$((n+{step})); done; kill -USR1 $$ ) >/dev/null 2>&1 &
  timer=$!
}}
watch_job() {{
  pid=$!
  ( while read -r line; do :; done; kill -USR2 $$ ) <&3 3<&- >/dev/null 2>&1 &
  dog=$!
  wait "$pid"
  rc=$?
  if [ "$stop" -eq 1 ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rc=130
  elif [ "$timed" -eq 1 ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rc={killed}
  fi
  kill "$dog" 2>/dev/null
  wait "$dog" 2>/dev/null
  return 0
}}
run() {{
  "$@" </dev/null 3<&- &
  watch_job
}}
run_to() {{
  out=$1
  shift
  "$@" </dev/null >"$out" 3<&- &
  watch_job
}}
"#,
        secs = secs,
        step = step,
        killed = KILLED_BY_WATCHDOG,
    )
}

// Packs into a temporary `.part` next to the target and renames it into
// place. GNU tar's exit code 1 means a file changed while it was read, and
// zip's 18 that a file could not be read. The archive is still made, and the
// tool's messages come back as a warning. A dangling link at the target name
// counts as the archive already being there.
const ARCHIVE_FNS: &str = r#"archive_main() {
  job_init
  archive_body "$@"
  rc=$?
  kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  return "$rc"
}
archive_body() {
  cd -- "$1" || return 1
  t=$2
  overwrite=$3
  format=$4
  shift 4
  case $format in
    zip) command -v zip >/dev/null 2>&1 || return 127 ;;
    *) command -v tar >/dev/null 2>&1 || return 127 ;;
  esac
  if [ "$overwrite" != 1 ] && { [ -e "$t" ] || [ -L "$t" ]; }; then
    echo __SUB_EXISTS
    return 17
  fi
  if [ -d "$t" ]; then
    echo "A folder with that name already exists"
    return 1
  fi
  part="$t.$$.part"
  if [ -e "$part" ] || [ -L "$part" ]; then
    echo "Temporary file $part already exists"
    return 1
  fi
  case $format in
    zip) run zip -r -q -y "$part" "$@" ;;
    tar) run tar -cf "$part" -- "$@" ;;
    tar.gz) run tar -czf "$part" -- "$@" ;;
  esac
  if [ "$stop" -eq 1 ]; then
    rc=130
  fi
  warn=0
  case $format/$rc in
    zip/18|tar/1|tar.gz/1) warn=1; rc=0 ;;
  esac
  if [ "$rc" -eq 0 ]; then
    if [ -d "$t" ]; then
      echo "A folder with that name appeared while packing"
      rc=1
    else
      mv -f -- "$part" "$t" || rc=1
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    rm -f -- "$part"
    return "$rc"
  fi
  if [ "$warn" -eq 1 ]; then
    echo __SUB_WARN
  fi
  return 0
}
"#;

fn archive_script(
    dir: &str,
    names: &[String],
    dest: &str,
    format: Format,
    overwrite: bool,
    secs: u64,
) -> String {
    // `./name` keeps a name that starts with `-` from being read as an option
    // by zip, which has no `--`; zip drops the `./` from the stored name.
    let names: Vec<String> = match format {
        Format::Zip => names
            .iter()
            .map(|n| sh_quote(&format!("./{}", n)))
            .collect(),
        Format::Tar | Format::TarGz => names.iter().map(|n| sh_quote(n)).collect(),
    };
    format!(
        "{jobs}{body}\narchive_main {dir} {dest} {overwrite} {word} {names}; rc=$?; exit $rc\n",
        jobs = job_fns(secs),
        body = ARCHIVE_FNS,
        dir = sh_quote(dir),
        dest = sh_quote(dest),
        overwrite = if overwrite { "1" } else { "0" },
        word = format_word(format),
        names = names.join(" "),
    )
}

// A member path that is absolute or has a `..` component. `\` counts as a
// separator too: unzip turns it into `/` for archives made on Windows.
const BAD_MEMBER: &str = r"^[/\\]|(^|[/\\])\.\.([/\\]|$)";
// What must not appear in a `tar -tv` listing: a link (`name -> target`,
// `name link to target`) with an absolute target, or a `..` component on ANY
// line. The second half is deliberately not tied to the link's own line: a
// target with a newline in it is printed across two lines by a tar that does
// not escape it, and the `..` would sit on a line with no `->`. Member names
// with `..` are refused anyway, so the only cost is an archive holding a file
// literally named like `a ..`.
const BAD_TAR_LISTING: &str = r"( -> | link to )/|(^|[ /])\.\.(/|$)";

// Moves the content of the staging folder `$2` into the real folder `$3`.
// `merge check` only looks, `merge move` does it; they run in that order so
// a refusal leaves the destination untouched. Same-named files are replaced
// (a symbolic link in a file's place is removed, not written through).
// A folder is merged into an existing folder, and refused where the
// destination has a symbolic link or a file: that is where unpacking straight
// into the destination would have written through the link.
const MERGE_FN: &str = r#"merge() {
  for f in "$2"/* "$2"/.[!.]* "$2"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    t="$3/${f##*/}"
    if [ -d "$f" ] && [ ! -L "$f" ]; then
      if [ -L "$t" ]; then echo "$t is a symbolic link, not extracting through it"; return 1
      elif [ -d "$t" ]; then ( merge "$1" "$f" "$t" ) || return 1
      elif [ -e "$t" ]; then echo "$t is a file, the archive has a folder there"; return 1
      elif [ "$1" = move ]; then mv -- "$f" "$t" || return 1
      fi
    elif [ -d "$t" ] && [ ! -L "$t" ]; then echo "$t is a folder, the archive has a file there"; return 1
    elif [ "$1" = move ]; then
      if [ -L "$t" ]; then rm -f -- "$t" || return 1; fi
      mv -f -- "$f" "$t" || return 1
    fi
  done
}"#;

// The listing is checked before anything is written. A member with an absolute
// path or a `..` component is refused, and so is a link that could redirect a
// later member. Device and FIFO members are refused. Run as root, setuid and
// setgid members are refused too, and tar is told not to restore owners.
// unzip reads `*`, `?` and `[` in an archive's name as a pattern, so such a
// name is read through a link with a plain name. Read-only folders from the
// archive are made owner-writable before the merge.
const EXTRACT_HEAD: &str = r#"chmod_tree() {
  chmod -R u+rwx "$1" 2>/dev/null || true
  return 0
}
extract_main() {
  job_init
  work=
  extract_body "$@"
  rc=$?
  if [ -n "$work" ]; then
    chmod_tree "$work"
    rm -rf -- "$work"
  fi
  kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  return "$rc"
}
extract_body() {
  cd -- "$1" || return 1
  a="./$2"
  folder=$3
  format=$4
  case $format in
    zip) command -v unzip >/dev/null 2>&1 || return 127 ;;
    *) command -v tar >/dev/null 2>&1 || return 127 ;;
  esac
  [ -f "$a" ] || { echo "Archive not found"; return 1; }
  work="./.submarine-extract.$$"
  mkdir -- "$work" || return 1
"#;

const EXTRACT_PLACE: &str = r#"if [ -n "$folder" ]; then
  d="./$folder"
  if [ -L "$d" ]; then echo "$d is a symbolic link, not extracting through it"; return 1
  elif [ -d "$d" ]; then merge check "$stage" "$d" && merge move "$stage" "$d" || return 1
  elif [ -e "$d" ]; then echo "$d exists and is not a folder"; return 1
  else mv -- "$stage" "$d" || return 1
  fi
else
  merge check "$stage" . && merge move "$stage" . || return 1
fi
"#;

fn extract_script(
    dir: &str,
    name: &str,
    folder: Option<&str>,
    format: Format,
    secs: u64,
) -> String {
    let z = if format == Format::TarGz { "z" } else { "" };
    let outside =
        "The archive could not be listed, or has entries that would land outside the destination";
    let link_msg = "The archive has a link that points outside the destination";
    let checks = match format {
        Format::Zip => format!(
            "z=$a\n\
             case $a in\n\
               *[*?[\\\\]*)\n\
               ln -s -- \"$PWD/${{a#./}}\" \"$work/a.zip\" || return 1\n\
               z=$work/a.zip\n\
               ;;\n\
             esac\n\
             run_to \"$work/names\" unzip -Z1 \"$z\"\n\
             if [ \"$rc\" -eq 130 ]; then return 130; fi\n\
             if [ \"$rc\" -ne 0 ]; then echo 'The archive could not be listed (unzip with zipinfo mode, -Z, is needed on the server)'; return 1; fi\n\
             if grep -Eq {bad} \"$work/names\"; then echo '{outside}'; return 1; fi\n\
             run_to \"$work/list\" unzip -Z \"$z\"\n\
             if [ \"$rc\" -eq 130 ]; then return 130; fi\n\
             if [ \"$rc\" -ne 0 ] || grep -q '^l' \"$work/list\"; then echo 'The archive contains symbolic links. Their targets cannot be checked on the server, so it is not extracted here'; return 1; fi\n\
             stage=\"$work/out\"\n\
             mkdir -- \"$stage\" || return 1\n\
             run unzip -o -q \"$z\" -d \"$stage\"\n",
            bad = sh_quote(BAD_MEMBER),
            outside = outside,
        ),
        Format::Tar | Format::TarGz => format!(
            "run_to \"$work/names\" tar -t{z}f \"$a\"\n\
             if [ \"$rc\" -eq 130 ]; then return 130; fi\n\
             if [ \"$rc\" -ne 0 ] || grep -Eq {bad} \"$work/names\"; then echo '{outside}'; return 1; fi\n\
             run_to \"$work/list\" tar -tv{z}f \"$a\"\n\
             if [ \"$rc\" -eq 130 ]; then return 130; fi\n\
             if [ \"$rc\" -ne 0 ] || grep -Eq {link} \"$work/list\"; then echo '{link_msg}'; return 1; fi\n\
             if grep -q '^[bcp]' \"$work/list\"; then echo \"The archive has device or FIFO entries, they aren't extracted\"; return 1; fi\n\
             root=0\n\
             [ \"$(id -u 2>/dev/null)\" = 0 ] && root=1\n\
             owner=\n\
             if [ \"$root\" -eq 1 ]; then\n\
             if grep -Eq '^...[sS]|^......[sS]' \"$work/list\"; then echo \"The archive has setuid or setgid files, they aren't extracted as root\"; return 1; fi\n\
             owner=-o\n\
             fi\n\
             stage=\"$work/out\"\n\
             mkdir -- \"$stage\" || return 1\n\
             run tar -x{z}f \"$a\" $owner -C \"$stage\"\n",
            z = z,
            bad = sh_quote(BAD_MEMBER),
            link = sh_quote(BAD_TAR_LISTING),
            outside = outside,
            link_msg = link_msg,
        ),
    };
    format!(
        "{jobs}{merge}\n{head}{checks}\
         if [ \"$rc\" -eq 130 ]; then return 130; fi\n\
         if [ \"$rc\" -ne 0 ]; then return \"$rc\"; fi\n\
         if [ \"$stop\" -eq 1 ]; then return 130; fi\n\
         chmod_tree \"$stage\"\n\
         {place}}}\n\
         extract_main {dir} {name} {folder} {word}; rc=$?; exit $rc\n",
        jobs = job_fns(secs),
        merge = MERGE_FN,
        head = EXTRACT_HEAD,
        checks = checks,
        place = EXTRACT_PLACE,
        dir = sh_quote(dir),
        name = sh_quote(name),
        folder = sh_quote(folder.unwrap_or("")),
        word = format_word(format),
    )
}

// The script gets a shell of its own (not a subshell), so `$$` in it is the
// pid of the shell that runs it: the watchdog signals that pid.
fn wrap_script(script: &str) -> String {
    format!(
        "out=$(sh -c {} 2>&1); rc=$?; printf '%s\\n' \"$out\" | tail -c 2000; echo __SUB_EXITCODE:$rc",
        sh_quote(script)
    )
}

/// Runs `script` under `sh` whatever the login shell is, and returns its exit
/// code with the tail of its output (stdout and stderr together).
#[allow(dead_code)]
async fn run_remote(
    state: &SshState,
    session_id: &str,
    script: &str,
) -> Result<(i32, String), String> {
    Ok(crate::parse_exit_marker(
        &run_remote_raw(state, session_id, script).await?,
    ))
}

/// `run_remote` without parsing: the raw output, exit marker included.
pub(crate) async fn run_remote_raw(
    state: &SshState,
    session_id: &str,
    script: &str,
) -> Result<String, String> {
    let cmd = format!("sh -c {}", sh_quote(&wrap_script(script)));
    crate::run_exec_capture(
        state,
        session_id,
        &cmd,
        REMOTE_TIMEOUT_SECS + REMOTE_WAIT_SLACK_SECS,
    )
    .await
}

fn remote_error(code: i32, out: &str, tool: &str) -> String {
    if code == 127 {
        return format!("`{}` is not installed on the server", tool);
    }
    if code == KILLED_BY_WATCHDOG {
        return format!(
            "{} was stopped on the server after {} minutes",
            tool,
            REMOTE_TIMEOUT_SECS / 60
        );
    }
    let out = out.trim();
    if out.is_empty() {
        format!("{} exited with code {}", tool, code)
    } else {
        out.to_string()
    }
}

/// Registers `job_id` in `transfer_cancels`. A Cancel that arrived first is
/// already set. An id another job or transfer is using is refused.
async fn start_job(
    state: &SshState,
    job_id: &str,
) -> Result<(Arc<AtomicBool>, crate::TransferCancelGuard), String> {
    let id_ok = !job_id.is_empty()
        && job_id.len() <= 80
        && job_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !id_ok {
        return Err("Invalid job id".into());
    }
    let map = Arc::clone(&state.transfer_cancels);
    let cancel = {
        let mut registered = map.lock().await;
        if registered.contains_key(job_id) {
            return Err("A job with this id is already running".into());
        }
        crate::take_transfer_cancel(&mut registered, &mut crate::lock_early_cancels(), job_id)
    };
    Ok((
        cancel,
        crate::TransferCancelGuard {
            map,
            id: job_id.to_string(),
        },
    ))
}

async fn login_session(
    state: &SshState,
    session_id: &str,
) -> Result<crate::SessionHandleArc, String> {
    let connections = state.connections.lock().await;
    connections
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Session not connected".to_string())
}

struct RemoteRun {
    code: Option<u32>,
    output: String,
}

fn keep_tail(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(data);
    if out.len() > OUTPUT_TAIL {
        let drop_n = out.len() - OUTPUT_TAIL;
        out.drain(..drop_n);
    }
}

/// Runs a job script with `sh -s`. The script goes in on stdin, which then
/// stays open: closing it is the cancel. A job that does not stop within
/// `CANCEL_GRACE_SECS` of that has its channel closed.
async fn run_remote_job(
    session: &crate::SessionHandleArc,
    script: &str,
    cancel: &AtomicBool,
) -> Result<RemoteRun, String> {
    use russh::ChannelMsg;
    use std::time::{Duration, Instant};
    let mut channel = {
        let session = session.lock().await;
        session
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?
    };
    channel
        .exec(true, "sh -s".as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    channel
        .data(script.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    let mut code: Option<u32> = None;
    let mut stop_sent: Option<Instant> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let deadline =
        Instant::now() + Duration::from_secs(REMOTE_TIMEOUT_SECS + REMOTE_WAIT_SLACK_SECS);
    loop {
        if Instant::now() >= deadline {
            let _ = channel.eof().await;
            let _ = channel.close().await;
            return Err(format!(
                "The archive tool was stopped on the server after {} minutes",
                REMOTE_TIMEOUT_SECS / 60
            ));
        }
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    keep_tail(&mut out, data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                // Eof is only "no more output". ExitStatus often follows it.
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
            _ = tick.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    match stop_sent {
                        None => {
                            let _ = channel.eof().await;
                            stop_sent = Some(Instant::now());
                        }
                        Some(at) if at.elapsed() >= Duration::from_secs(CANCEL_GRACE_SECS) => {
                            let _ = channel.close().await;
                            break;
                        }
                        Some(_) => {}
                    }
                }
            }
        }
    }
    if stop_sent.is_some() {
        return Err(cancelled());
    }
    Ok(RemoteRun {
        code,
        output: String::from_utf8_lossy(&out).into_owned(),
    })
}

fn remote_outcome(run: RemoteRun, tool: &str, dest: &str) -> Result<Option<String>, String> {
    let out = run.output.trim();
    let message = || {
        let lines: Vec<&str> = out
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("__SUB_"))
            .collect();
        let start = lines.len().saturating_sub(12);
        lines[start..].join("\n")
    };
    match run.code {
        Some(0) if out.lines().any(|line| line.trim() == WARN_MARKER) => Ok(Some(message())),
        Some(0) => Ok(None),
        Some(17) if out.contains(EXISTS_MARKER) => Err(format!("EXISTS:{}", dest)),
        Some(127) => Err(format!("`{}` is not installed on the server", tool)),
        Some(130) => Err(cancelled()),
        Some(code) if code == KILLED_BY_WATCHDOG as u32 => {
            Err(remote_error(KILLED_BY_WATCHDOG, "", tool))
        }
        Some(code) => {
            let msg = message();
            Err(if msg.is_empty() {
                remote_error(code as i32, "", tool)
            } else {
                msg
            })
        }
        None => Err("The connection closed before the server reported a result".into()),
    }
}

/// Remote counterpart of `local_archive`: packs `names` (entries of `dir`)
/// into `dest` on the server.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_archive(
    state: tauri::State<'_, SshState>,
    session_id: String,
    dir: String,
    names: Vec<String>,
    dest: String,
    format: String,
    overwrite: bool,
    job_id: String,
) -> Result<Option<String>, String> {
    let format = parse_format(&format)?;
    check_remote_names(&names)?;
    check_remote_dest(&dest)?;
    let session = login_session(&state, &session_id).await?;
    let (cancel, _job) = start_job(&state, &job_id).await?;
    let script = archive_script(&dir, &names, &dest, format, overwrite, REMOTE_TIMEOUT_SECS);
    let run = run_remote_job(&session, &script, &cancel).await?;
    remote_outcome(
        run,
        if format == Format::Zip { "zip" } else { "tar" },
        &dest,
    )
}

/// Remote counterpart of `local_extract`; see `extract_script`.
#[tauri::command]
pub async fn sftp_extract(
    state: tauri::State<'_, SshState>,
    session_id: String,
    dir: String,
    name: String,
    folder: Option<String>,
    job_id: String,
) -> Result<Option<String>, String> {
    let format = check_remote_extract(&name, folder.as_deref())?;
    let session = login_session(&state, &session_id).await?;
    let (cancel, _job) = start_job(&state, &job_id).await?;
    let script = extract_script(&dir, &name, folder.as_deref(), format, REMOTE_TIMEOUT_SECS);
    let run = run_remote_job(&session, &script, &cancel).await?;
    remote_outcome(
        run,
        if format == Format::Zip {
            "unzip"
        } else {
            "tar"
        },
        &name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("submarine-{}-test-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recognises_archives_by_name() {
        assert_eq!(format_of_name("a.zip"), Some(Format::Zip));
        assert_eq!(format_of_name("A.ZIP"), Some(Format::Zip));
        assert_eq!(format_of_name("a.tar"), Some(Format::Tar));
        assert_eq!(format_of_name("a.tar.gz"), Some(Format::TarGz));
        assert_eq!(format_of_name("a.tgz"), Some(Format::TarGz));
        assert_eq!(format_of_name("a.gz"), None);
        assert_eq!(format_of_name("tar"), None);
    }

    #[test]
    fn scripts_quote_every_path() {
        let names = strings(&["it's", "-rf"]);
        let tar = archive_script(
            "/srv/my dir",
            &names,
            "/srv/my dir/out.tar.gz",
            Format::TarGz,
            false,
            60,
        );
        assert!(tar.contains(
            "archive_main '/srv/my dir' '/srv/my dir/out.tar.gz' 0 tar.gz 'it'\"'\"'s' '-rf'"
        ));
        assert!(tar.contains("part=\"$t.$$.part\""));
        assert!(tar.contains("tar -czf \"$part\" -- \"$@\""));
        let zip = archive_script("/srv", &names, "/srv/out.zip", Format::Zip, true, 60);
        assert!(zip.contains(EXISTS_MARKER));
        assert!(zip.contains("archive_main '/srv' '/srv/out.zip' 1 zip './it'\"'\"'s' './-rf'"));
        assert!(zip.contains("zip -r -q -y \"$part\" \"$@\""));
        let unzip = extract_script("/srv/a b", "it's.zip", Some("-x y"), Format::Zip, 60);
        assert!(unzip.contains("extract_main '/srv/a b' 'it'\"'\"'s.zip' '-x y' zip"));
        assert!(unzip.contains("cd -- \"$1\" || return 1"));
    }

    // A file already under the temporary name is refused, not cleared: the
    // only `rm` in the script comes after the tool has created `$part`. And
    // the "is it a folder" check is repeated between the tool and the `mv`.
    #[test]
    fn archive_script_order() {
        let script = archive_script(
            "/srv",
            &strings(&["a"]),
            "/srv/o.zip",
            Format::Zip,
            true,
            60,
        );
        let guard = script.find("if [ -e \"$part\" ]").unwrap();
        let pack = script.find("zip -r").unwrap();
        let recheck = script.rfind("if [ -d \"$t\" ]").unwrap();
        let mv = script.find("mv -f").unwrap();
        let cleanup = script.find("rm -f -- \"$part\"").unwrap();
        assert!(guard < pack && pack < recheck && recheck < mv && mv < cleanup);
        assert_eq!(script.matches("rm -f").count(), 1);
        assert_eq!(script.matches("if [ -d \"$t\" ]").count(), 2);
    }

    // Nothing is unpacked before the listing has been checked.
    #[test]
    fn extract_script_checks_before_unpacking() {
        for (name, format, list, unpack) in [
            ("a.tar.gz", Format::TarGz, "tar -tzf", "tar -xzf"),
            ("a.tar", Format::Tar, "tar -tf", "tar -xf"),
            ("a.zip", Format::Zip, "unzip -Z1", "unzip -o"),
        ] {
            let script = extract_script("/srv", name, None, format, 60);
            let check = script.find(list).unwrap();
            let stage = script.find("mkdir -- \"$stage\"").unwrap();
            let run = script.find(unpack).unwrap();
            assert!(check < stage && stage < run, "{}", name);
            assert!(
                script.contains("-d \"$stage\"") || script.contains("-C \"$stage\""),
                "{}",
                name
            );
        }
    }

    // `..` (or a path) as a member would pack the parent / another folder.
    #[test]
    fn member_names_are_single_components() {
        assert!(check_names(&strings(&["a", "b c", "-rf"])).is_ok());
        // Win32 drops a trailing dot, so `...` is not the name that would be stored.
        if cfg!(windows) {
            assert!(check_names(&strings(&["..."])).is_err());
        } else {
            assert!(check_names(&strings(&["..."])).is_ok());
        }
        for bad in ["..", ".", "", "a/b", "../x", "a\\b"] {
            assert!(check_names(&strings(&["ok", bad])).is_err(), "{:?}", bad);
        }
        assert!(check_names(&[]).is_err());
    }

    // Neither the archive nor the target folder can point out of `dir`.
    #[test]
    fn extract_names_are_single_components() {
        assert_eq!(check_extract_names("a.zip", None), Ok(Format::Zip));
        assert_eq!(
            check_extract_names("a.tar.gz", Some("a")),
            Ok(Format::TarGz)
        );
        assert_eq!(
            check_extract_names("....zip", Some(".hidden")),
            Ok(Format::Zip)
        );
        for bad in [
            "../x.zip",
            "foo/../../tmp/x.zip",
            "/etc/x.zip",
            "a\\x.zip",
            "..",
            "",
        ] {
            assert!(check_extract_names(bad, None).is_err(), "{:?}", bad);
        }
        // The last five are `.` / `..` / another name once Windows has
        // dropped the trailing spaces and dots.
        for bad in [
            "..",
            ".",
            "",
            " ",
            "../x",
            "foo/../../tmp/x",
            "/tmp",
            "a/b",
            "a\\b",
            ".. ",
            ". ",
            "...",
            " x",
            "x ",
            "v1.",
        ] {
            assert!(
                check_extract_names("a.zip", Some(bad)).is_err(),
                "{:?}",
                bad
            );
        }
        assert!(check_extract_names("notes.txt", None).is_err());
    }

    // The listing check, on the lines a `tar -tv` prints.
    #[test]
    fn tar_listing_pattern() {
        if sh("true").is_none() {
            eprintln!("tar_listing_pattern: SKIPPED, no sh");
            return;
        }
        let hit = |line: &str| {
            let script = format!(
                "printf '%s\\n' {} | grep -Eq {}",
                sh_quote(line),
                sh_quote(BAD_TAR_LISTING)
            );
            sh(&script).unwrap().0 == 0
        };
        for fine in [
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 docs/current -> v2",
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 a/b/l -> sub/file",
            "hrw-r--r-- 0/0 0 1970-01-01 02:00 copy link to folder/b.txt",
            "-rw-r--r-- u/g 4 2024-01-01 12:00 a..b/c../..d/...",
            "drwxr-xr-x u/g 0 2024-01-01 12:00 .hidden/",
        ] {
            assert!(!hit(fine), "{}", fine);
        }
        for bad in [
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 link -> ..",
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 link -> ../x",
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 a/l -> x/../../..",
            "lrwxrwxrwx 0/0 0 1970-01-01 02:00 link -> /etc",
            "hrw-r--r-- 0/0 0 1970-01-01 02:00 h link to /etc/passwd",
            "hrw-r--r-- 0/0 0 1970-01-01 02:00 h link to ../outside",
            // Second line of a target printed raw as "x<newline>../.." .
            "../..",
            "y/../../z",
        ] {
            assert!(hit(bad), "{}", bad);
        }
    }

    // A link to a folder. On Windows a junction: it needs no privilege, and
    // it is the kind of link `is_symlink` alone could miss.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, link).is_ok();
        #[cfg(windows)]
        return std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }

    fn extract_here(dir: &Path, name: &str, folder: Option<&str>) -> Result<(), String> {
        let format = check_extract_names(name, folder)?;
        let base = local_work_dir(&dir.to_string_lossy())?;
        extract_local(
            &base,
            &base.join(name),
            folder,
            format,
            &AtomicBool::new(false),
        )
    }

    // "Extract to site/" where `site` is a link (or junction), and "Extract
    // here" where the archive's `site/` would go through one: both refused,
    // as the remote script does, and nothing reaches what the link points at.
    #[test]
    fn local_extract_does_not_go_through_a_link() {
        let root = temp_root("local-link");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("site")).unwrap();
        std::fs::write(src.join("top.txt"), b"top").unwrap();
        std::fs::write(src.join("site/x.txt"), b"x").unwrap();
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::fs::write(work.join("file"), b"f").unwrap();
        pack_local(
            &src,
            &strings(&["top.txt", "site"]),
            &root.join("p"),
            &work.join("o.zip"),
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();
        pack_local(
            &src,
            &strings(&["top.txt", "site"]),
            &root.join("p"),
            &work.join("o.tar"),
            Format::Tar,
            &AtomicBool::new(false),
        )
        .unwrap();

        // A plain file under the folder's name is refused too.
        let err = extract_here(&work, "o.zip", Some("file")).unwrap_err();
        assert!(err.contains("not a folder"), "{}", err);

        assert!(
            link_dir(&root.join("elsewhere"), &work.join("site")),
            "could not create a link / junction"
        );
        let meta = std::fs::symlink_metadata(work.join("site")).unwrap();
        assert!(is_link(&meta));
        for name in ["o.zip", "o.tar"] {
            for folder in [Some("site"), None] {
                let err = extract_here(&work, name, folder).unwrap_err();
                assert!(err.contains("is a link"), "{} {:?}: {}", name, folder, err);
                assert_eq!(
                    std::fs::read_dir(root.join("elsewhere")).unwrap().count(),
                    0,
                    "{} {:?}",
                    name,
                    folder
                );
                assert!(!work.join("top.txt").exists(), "{} {:?}", name, folder);
                no_staging_left(&work);
            }
        }
        // The link itself is still there and still a link.
        assert!(is_link(
            &std::fs::symlink_metadata(work.join("site")).unwrap()
        ));
        let _ = std::fs::remove_dir(work.join("site"));
        let _ = std::fs::remove_file(work.join("site"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // Same-named files are replaced, the rest of an existing folder stays,
    // and a file where the archive has a folder stops it before anything moves.
    #[test]
    fn local_extract_merges() {
        let root = temp_root("local-merge");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("folder/inner")).unwrap();
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::write(src.join("folder/inner/b.txt"), b"beta").unwrap();
        let work = root.join("work");
        std::fs::create_dir_all(work.join("folder/inner")).unwrap();
        std::fs::write(work.join("a.txt"), b"old").unwrap();
        std::fs::write(work.join("folder/inner/b.txt"), b"old").unwrap();
        std::fs::write(work.join("folder/mine.txt"), b"mine").unwrap();
        for (format, name) in [(Format::Zip, "o.zip"), (Format::TarGz, "o.tgz")] {
            pack_local(
                &src,
                &strings(&["a.txt", "folder"]),
                &root.join("p"),
                &work.join(name),
                format,
                &AtomicBool::new(false),
            )
            .unwrap();
            std::fs::write(work.join("a.txt"), b"old").unwrap();
            extract_here(&work, name, None).unwrap();
            assert_eq!(
                std::fs::read(work.join("a.txt")).unwrap(),
                b"alpha",
                "{}",
                name
            );
            assert_eq!(
                std::fs::read(work.join("folder/inner/b.txt")).unwrap(),
                b"beta",
                "{}",
                name
            );
            assert_eq!(
                std::fs::read(work.join("folder/mine.txt")).unwrap(),
                b"mine",
                "{}",
                name
            );
            no_staging_left(&work);
        }
        let clash = root.join("clash");
        std::fs::create_dir_all(&clash).unwrap();
        std::fs::write(clash.join("folder"), b"a file").unwrap();
        std::fs::copy(work.join("o.zip"), clash.join("o.zip")).unwrap();
        let err = extract_here(&clash, "o.zip", None).unwrap_err();
        assert!(err.contains("folder is a file"), "{}", err);
        assert!(!clash.join("a.txt").exists());
        assert_eq!(std::fs::read(clash.join("folder")).unwrap(), b"a file");
        no_staging_left(&clash);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn link_targets_that_leave_the_folder() {
        for fine in [
            "v2", "sub/file", "./a/b", ".hidden", "a../b", "x .", "..a", "a b",
        ] {
            assert!(link_target_inside(Path::new(fine)), "{:?}", fine);
        }
        // The last six are `..` / `.` once Win32 has dropped trailing spaces
        // and dots.
        for bad in [
            "..",
            "../secret",
            "a/../../secret",
            "/etc",
            ".. ",
            ".. .",
            "a/.. /x",
            "...",
            ". ",
            " ",
        ] {
            assert!(!link_target_inside(Path::new(bad)), "{:?}", bad);
        }
        #[cfg(windows)]
        for bad in [
            "C:\\Windows",
            "\\Windows",
            "..\\secret",
            "a\\.. \\x",
            "\\\\server\\share",
        ] {
            assert!(!link_target_inside(Path::new(bad)), "{:?}", bad);
        }
    }

    // A link that took the destination's name while the archive was being
    // unpacked: the staged tree must not be merged through it.
    #[test]
    fn a_link_that_appears_at_the_destination_is_not_merged_through() {
        let root = temp_root("late-link");
        let work = root.join("work");
        let stage = work.join(".submarine-extract.test");
        std::fs::create_dir_all(stage.join("sub")).unwrap();
        std::fs::write(stage.join("a.txt"), b"alpha").unwrap();
        std::fs::write(stage.join("sub/b.txt"), b"beta").unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        // The folder was free when the extract started...
        let dest = local_extract_dest(&work, Some("site")).unwrap();
        // ...and is a link by the time the unpack is done.
        assert!(
            link_dir(&root.join("elsewhere"), &work.join("site")),
            "could not create a link / junction"
        );
        let err = place_staged(&stage, &dest, "site").unwrap_err();
        assert!(err.contains("is a link"), "{}", err);
        assert_eq!(
            std::fs::read_dir(root.join("elsewhere")).unwrap().count(),
            0
        );
        assert!(stage.join("a.txt").exists() && stage.join("sub/b.txt").exists());
        // A file that took the name is refused as well.
        std::fs::write(work.join("taken"), b"f").unwrap();
        let err = place_staged(&stage, &work.join("taken"), "taken").unwrap_err();
        assert!(err.contains("not a folder"), "{}", err);
        // A free name is one rename.
        place_staged(&stage, &work.join("fresh"), "fresh").unwrap();
        assert_eq!(
            std::fs::read(work.join("fresh/sub/b.txt")).unwrap(),
            b"beta"
        );
        let _ = std::fs::remove_dir(work.join("site"));
        let _ = std::fs::remove_file(work.join("site"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // A link member pointing out of the destination fails the whole archive,
    // as on the remote side, and is not left behind.
    #[test]
    fn local_extract_refuses_a_link_pointing_outside() {
        let root = temp_root("local-hostile");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(root.join("secret"), b"keep").unwrap();
        for (case, target) in [
            ("up", "../secret"),
            ("abs", "/etc"),
            ("nested", "a/../../secret"),
            ("up-space", ".. "),
            ("up-space-dot", ".. ."),
        ] {
            let name = format!("{}.tar", case);
            std::fs::write(
                work.join(&name),
                raw_tar(&[
                    ("ok.txt", Regular, "", b"ok"),
                    ("link", Symlink, target, b""),
                ]),
            )
            .unwrap();
            for folder in [None, Some("out")] {
                // Without the privilege to create links on Windows the unpack
                // itself fails; either way the archive must not be applied.
                let err = extract_here(&work, &name, folder).unwrap_err();
                eprintln!(
                    "local_extract_refuses_a_link_pointing_outside: {} {:?}: {}",
                    case, folder, err
                );
                assert!(
                    std::fs::symlink_metadata(work.join("link")).is_err(),
                    "{} {:?}",
                    case,
                    folder
                );
                assert!(
                    !work.join("ok.txt").exists() && !work.join("out").exists(),
                    "{} {:?}",
                    case,
                    folder
                );
                no_staging_left(&work);
            }
        }
        assert_eq!(std::fs::read(root.join("secret")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn local_round_trip() {
        let root = temp_root("archive");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("folder/inner")).unwrap();
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::write(src.join("folder/inner/b.txt"), b"beta").unwrap();
        let names = strings(&["a.txt", "folder"]);
        for (format, file) in [
            (Format::Zip, "o.zip"),
            (Format::Tar, "o.tar"),
            (Format::TarGz, "o.tar.gz"),
        ] {
            pack_local(
                &src,
                &names,
                &root.join(format!("{}.part", file)),
                &root.join(file),
                format,
                &AtomicBool::new(false),
            )
            .unwrap();
            let folder = format!("out-{}", file);
            extract_here(&root, file, Some(&folder)).unwrap();
            let out = root.join(folder);
            assert_eq!(
                std::fs::read(out.join("a.txt")).unwrap(),
                b"alpha",
                "{}",
                file
            );
            assert_eq!(
                std::fs::read(out.join("folder/inner/b.txt")).unwrap(),
                b"beta",
                "{}",
                file
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_time_is_the_utc_calendar_date() {
        let root = temp_root("ziptime");
        let path = root.join("f");
        std::fs::write(&path, b"x").unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        // 2024-02-29 12:34:56 UTC
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_709_210_096))
            .unwrap();
        let t = zip_time(&file.metadata().unwrap()).unwrap();
        drop(file);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(
            (
                t.year(),
                t.month(),
                t.day(),
                t.hour(),
                t.minute(),
                t.second()
            ),
            (2024, 2, 29, 12, 34, 56)
        );
    }

    // Links to a file and to a folder, both pointing out of `src`. None when
    // this machine cannot create links (Windows without the privilege).
    fn make_links(root: &Path, src: &Path) -> Option<()> {
        std::fs::create_dir_all(src.join("folder")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/secret"), b"TOP SECRET").unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink("../../outside/secret", src.join("folder/link"))
            .and_then(|()| std::os::unix::fs::symlink("../outside", src.join("dirlink")));
        #[cfg(windows)]
        let made =
            std::os::windows::fs::symlink_file("..\\..\\outside\\secret", src.join("folder/link"))
                .and_then(|()| {
                    std::os::windows::fs::symlink_dir("..\\outside", src.join("dirlink"))
                });
        made.ok()
    }

    // A link is stored as a link: its target's content must not be pulled in.
    #[test]
    fn archives_store_a_symlink_not_its_target() {
        let root = temp_root("link");
        let src = root.join("src");
        if make_links(&root, &src).is_none() {
            eprintln!(
                "archives_store_a_symlink_not_its_target: SKIPPED, cannot create symlinks here"
            );
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let names = strings(&["folder", "dirlink"]);
        let zip_path = root.join("o.zip");
        pack_local(
            &src,
            &names,
            &root.join("o.zip.part"),
            &zip_path,
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();
        let bytes = std::fs::read(&zip_path).unwrap();
        assert!(!bytes.windows(10).any(|w| w == b"TOP SECRET"));
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let listed: Vec<String> = zip.file_names().map(|n| n.to_string()).collect();
        assert!(
            !listed.iter().any(|n| n.starts_with("dirlink/")),
            "{:?}",
            listed
        );
        for (name, target) in [
            ("folder/link", "../../outside/secret"),
            ("dirlink", "../outside"),
        ] {
            let mut entry = zip.by_name(name).unwrap();
            assert!(entry.is_symlink(), "{}", name);
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            assert_eq!(content, target, "{}", name);
        }
        let tar_path = root.join("o.tar");
        pack_local(
            &src,
            &names,
            &root.join("o.tar.part"),
            &tar_path,
            Format::Tar,
            &AtomicBool::new(false),
        )
        .unwrap();
        let bytes = std::fs::read(&tar_path).unwrap();
        assert!(!bytes.windows(10).any(|w| w == b"TOP SECRET"));
        let mut kinds = Vec::new();
        for entry in tar::Archive::new(std::io::Cursor::new(bytes))
            .entries()
            .unwrap()
        {
            let entry = entry.unwrap();
            kinds.push((
                entry.path().unwrap().to_string_lossy().replace('\\', "/"),
                entry.header().entry_type(),
            ));
        }
        assert!(
            kinds.contains(&("folder/link".to_string(), tar::EntryType::Symlink)),
            "{:?}",
            kinds
        );
        assert!(
            kinds.contains(&("dirlink".to_string(), tar::EntryType::Symlink)),
            "{:?}",
            kinds
        );
        assert!(
            !kinds.iter().any(|(n, _)| n.starts_with("dirlink/")),
            "{:?}",
            kinds
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // Reading a FIFO would block until someone writes to it.
    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_not_read() {
        let root = temp_root("fifo");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("folder")).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(src.join("folder/pipe"))
            .status();
        if !made.map(|s| s.success()).unwrap_or(false) {
            eprintln!("a_fifo_is_refused_not_read: SKIPPED, no mkfifo");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        for (format, file) in [
            (Format::Zip, "o.zip"),
            (Format::Tar, "o.tar"),
            (Format::TarGz, "o.tar.gz"),
        ] {
            let part = root.join(format!("{}.part", file));
            let err = pack_local(
                &src,
                &strings(&["folder"]),
                &part,
                &root.join(file),
                format,
                &AtomicBool::new(false),
            )
            .unwrap_err();
            assert!(err.contains("folder/pipe"), "{}", err);
            assert!(!part.exists() && !root.join(file).exists(), "{}", file);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // The cleanup after a failed run must not take a file this run did not
    // create: here the temporary name is already someone else's.
    #[test]
    fn a_file_under_the_temporary_name_is_kept() {
        let root = temp_root("part");
        std::fs::write(root.join("a.txt"), b"alpha").unwrap();
        let taken = root.join("o.zip.part");
        std::fs::write(&taken, b"mine").unwrap();
        let err = pack_local(
            &root,
            &strings(&["a.txt"]),
            &taken,
            &root.join("o.zip"),
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(err.contains("temporary file"), "{}", err);
        assert_eq!(std::fs::read(&taken).unwrap(), b"mine");
        assert!(!root.join("o.zip").exists());
        // A run that did create it removes it when the packing fails.
        let part = root.join("p.zip.part");
        assert!(pack_local(
            &root,
            &strings(&["missing"]),
            &part,
            &root.join("p.zip"),
            Format::Zip,
            &AtomicBool::new(false)
        )
        .is_err());
        assert!(!part.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- the remote scripts, run for real under a local `sh` -----------------

    // Exit code and output, as `run_remote` would see them. None when there
    // is no `sh` to run (plain Windows): the caller skips.
    fn sh(script: &str) -> Option<(i32, String)> {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(wrap_script(script))
            .output()
            .ok()?;
        Some(crate::parse_exit_marker(&String::from_utf8_lossy(
            &out.stdout,
        )))
    }

    fn have(tool: &str) -> bool {
        matches!(
            sh(&format!("command -v {} >/dev/null 2>&1", tool)),
            Some((0, _))
        )
    }

    // `.` for the script's `cd`: the tests run it with `dir` as the working
    // directory, which keeps a Windows `C:\` path away from tar.
    // The script is fed to `sh -s` and stdin stays open until the process
    // exits. Closing it early is Cancel: the watcher reads that as EOF.
    fn sh_in(dir: &Path, script: &str) -> (i32, String) {
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};
        let mut child = Command::new("sh")
            .arg("-s")
            .current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = stderr.read_to_end(&mut err);
            out.extend_from_slice(&err);
            String::from_utf8_lossy(&out).into_owned()
        });
        stdin.write_all(script.as_bytes()).unwrap();
        stdin.flush().unwrap();
        let status = child.wait().unwrap();
        drop(stdin);
        (status.code().unwrap_or(1), reader.join().unwrap())
    }

    // A tar entry with the name and link target written as given: the
    // builder's own setters would refuse `..`.
    fn raw_tar(entries: &[(&str, tar::EntryType, &str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, kind, link, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            header.as_old_mut().linkname[..link.len()].copy_from_slice(link.as_bytes());
            header.set_entry_type(*kind);
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap()
    }

    fn no_staging_left(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().to_string();
            assert!(
                !name.starts_with(".submarine-extract"),
                "staging left behind: {}",
                name
            );
        }
    }

    use tar::EntryType::{Directory, Link, Regular, Symlink};

    #[test]
    fn remote_extract_refuses_hostile_tar() {
        if !have("tar") {
            eprintln!("remote_extract_refuses_hostile_tar: SKIPPED, no sh / tar");
            return;
        }
        let root = temp_root("hostile-tar");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let cases: Vec<(&str, Vec<u8>)> = vec![
            (
                "dotdot",
                raw_tar(&[
                    ("ok.txt", Regular, "", b"ok"),
                    ("../evil", Regular, "", b"evil"),
                ]),
            ),
            (
                "nested-dotdot",
                raw_tar(&[("a/../../evil", Regular, "", b"evil")]),
            ),
            (
                "absolute",
                raw_tar(&[("/tmp/submarine-evil", Regular, "", b"evil")]),
            ),
            (
                "link-up",
                raw_tar(&[
                    ("link", Symlink, "..", b""),
                    ("link/evil", Regular, "", b"evil"),
                ]),
            ),
            (
                "link-abs",
                raw_tar(&[
                    ("link", Symlink, "/tmp", b""),
                    ("link/submarine-evil", Regular, "", b"evil"),
                ]),
            ),
            (
                "link-nested",
                raw_tar(&[
                    ("a", Directory, "", b""),
                    ("a/l", Symlink, "x/../../..", b""),
                ]),
            ),
            // A target with a newline before the `..`: two lines in the
            // listing of a tar that prints it raw.
            (
                "link-newline",
                raw_tar(&[
                    ("a", Directory, "", b""),
                    ("a/l", Symlink, "x\n../../..", b""),
                    ("a/l/evil", Regular, "", b"evil"),
                ]),
            ),
        ];
        std::fs::write(root.join("outside"), b"keep").unwrap();
        for (case, bytes) in cases {
            let name = format!("{}.tar", case);
            std::fs::write(work.join(&name), bytes).unwrap();
            for folder in [None, Some("out")] {
                let (code, out) =
                    sh_in(&work, &extract_script(".", &name, folder, Format::Tar, 60));
                assert_eq!(code, 1, "{} {:?}: {}", case, folder, out);
                assert!(
                    out.contains("outside the destination"),
                    "{} {:?}: {}",
                    case,
                    folder,
                    out
                );
                assert!(
                    !root.join("evil").exists() && !work.join("evil").exists(),
                    "{}",
                    case
                );
                assert!(
                    !work.join("out").exists() && !work.join("ok.txt").exists(),
                    "{}",
                    case
                );
                assert!(
                    !work.join("link").exists()
                        && !work.join("a").exists()
                        && !work.join("h").exists(),
                    "{}",
                    case
                );
                no_staging_left(&work);
            }
        }
        // A hard link to a file outside. GNU tar drops the `../` from the
        // target in its listing (and when extracting), so the listing check
        // may not see it; a tar that keeps it is refused by that check.
        // Either way nothing may be linked to the outside file.
        std::fs::write(
            work.join("hardlink.tar"),
            raw_tar(&[("h", Link, "../outside", b"")]),
        )
        .unwrap();
        for folder in [None, Some("out")] {
            let (code, out) = sh_in(
                &work,
                &extract_script(".", "hardlink.tar", folder, Format::Tar, 60),
            );
            assert_ne!(code, 0, "hardlink {:?}: {}", folder, out);
            assert!(
                !work.join("h").exists() && !work.join("out").exists(),
                "hardlink {:?}",
                folder
            );
            no_staging_left(&work);
        }
        assert_eq!(std::fs::read(root.join("outside")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_extract_refuses_hostile_zip() {
        if !have("unzip") {
            eprintln!("remote_extract_refuses_hostile_zip: SKIPPED, no sh / unzip");
            return;
        }
        let root = temp_root("hostile-zip");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let opts = zip::write::SimpleFileOptions::default();
        let build = |fill: &dyn Fn(&mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>)| {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            fill(&mut zw);
            zw.finish().unwrap().into_inner()
        };
        let cases: Vec<(&str, &str, Vec<u8>)> = vec![
            (
                "dotdot",
                "outside the destination",
                build(&|zw| {
                    zw.start_file("ok.txt", opts).unwrap();
                    zw.write_all(b"ok").unwrap();
                    zw.start_file("../evil", opts).unwrap();
                    zw.write_all(b"evil").unwrap();
                }),
            ),
            (
                "backslash",
                "outside the destination",
                build(&|zw| {
                    zw.start_file("..\\evil", opts).unwrap();
                    zw.write_all(b"evil").unwrap();
                }),
            ),
            (
                "link",
                "symbolic links",
                build(&|zw| {
                    zw.add_symlink("link", "..", opts).unwrap();
                    zw.start_file("link/evil", opts).unwrap();
                    zw.write_all(b"evil").unwrap();
                }),
            ),
        ];
        for (case, why, bytes) in cases {
            let name = format!("{}.zip", case);
            std::fs::write(work.join(&name), bytes).unwrap();
            for folder in [None, Some("out")] {
                let (code, out) =
                    sh_in(&work, &extract_script(".", &name, folder, Format::Zip, 60));
                assert_eq!(code, 1, "{} {:?}: {}", case, folder, out);
                assert!(out.contains(why), "{} {:?}: {}", case, folder, out);
                assert!(
                    !root.join("evil").exists() && !work.join("evil").exists(),
                    "{}",
                    case
                );
                assert!(
                    !work.join("out").exists()
                        && !work.join("ok.txt").exists()
                        && !work.join("link").exists(),
                    "{}",
                    case
                );
                no_staging_left(&work);
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_extract_places_and_merges() {
        if !have("tar") {
            eprintln!("remote_extract_places_and_merges: SKIPPED, no sh / tar");
            return;
        }
        let root = temp_root("extract");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("folder/inner")).unwrap();
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::write(src.join(".hidden"), b"dot").unwrap();
        std::fs::write(src.join("folder/inner/b.txt"), b"beta").unwrap();
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let names = strings(&["a.txt", ".hidden", "folder"]);
        pack_local(
            &src,
            &names,
            &root.join("p"),
            &work.join("-o.tar.gz"),
            Format::TarGz,
            &AtomicBool::new(false),
        )
        .unwrap();
        pack_local(
            &src,
            &names,
            &root.join("p"),
            &work.join("o.zip"),
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();

        // Into a new folder.
        let (code, out) = sh_in(
            &work,
            &extract_script(".", "-o.tar.gz", Some("new one"), Format::TarGz, 60),
        );
        assert_eq!(code, 0, "{}", out);
        assert_eq!(
            std::fs::read(work.join("new one/folder/inner/b.txt")).unwrap(),
            b"beta"
        );
        assert_eq!(std::fs::read(work.join("new one/.hidden")).unwrap(), b"dot");

        // Here, over existing content: same-named files are replaced, the
        // rest of an existing folder stays.
        std::fs::create_dir_all(work.join("folder/inner")).unwrap();
        std::fs::write(work.join("folder/inner/b.txt"), b"old").unwrap();
        std::fs::write(work.join("folder/mine.txt"), b"mine").unwrap();
        std::fs::write(work.join("a.txt"), b"old").unwrap();
        let (code, out) = sh_in(
            &work,
            &extract_script(".", "-o.tar.gz", None, Format::TarGz, 60),
        );
        assert_eq!(code, 0, "{}", out);
        assert_eq!(std::fs::read(work.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(
            std::fs::read(work.join("folder/inner/b.txt")).unwrap(),
            b"beta"
        );
        assert_eq!(
            std::fs::read(work.join("folder/mine.txt")).unwrap(),
            b"mine"
        );
        no_staging_left(&work);

        // A file where the archive has a folder: refused before anything moves.
        let clash = work.join("clash");
        std::fs::create_dir_all(&clash).unwrap();
        std::fs::write(clash.join("folder"), b"a file").unwrap();
        std::fs::copy(work.join("-o.tar.gz"), clash.join("o.tar.gz")).unwrap();
        let (code, out) = sh_in(
            &clash,
            &extract_script(".", "o.tar.gz", None, Format::TarGz, 60),
        );
        assert_eq!(code, 1, "{}", out);
        assert!(out.contains("./folder is a file"), "{}", out);
        assert!(!clash.join("a.txt").exists() && !clash.join(".hidden").exists());
        assert_eq!(std::fs::read(clash.join("folder")).unwrap(), b"a file");
        no_staging_left(&clash);

        if have("unzip") {
            let (code, out) = sh_in(
                &work,
                &extract_script(".", "o.zip", Some("z"), Format::Zip, 60),
            );
            assert_eq!(code, 0, "{}", out);
            assert_eq!(
                std::fs::read(work.join("z/folder/inner/b.txt")).unwrap(),
                b"beta"
            );
            no_staging_left(&work);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // A folder of the archive must not be unpacked through a symbolic link
    // that is already in the destination.
    #[test]
    fn remote_extract_does_not_write_through_an_existing_link() {
        if !have("tar") {
            eprintln!(
                "remote_extract_does_not_write_through_an_existing_link: SKIPPED, no sh / tar"
            );
            return;
        }
        let root = temp_root("through-link");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink("../elsewhere", work.join("folder"));
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir("..\\elsewhere", work.join("folder"));
        if made.is_err() {
            eprintln!("remote_extract_does_not_write_through_an_existing_link: SKIPPED, cannot create symlinks here");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(
            work.join("o.tar"),
            raw_tar(&[
                ("top.txt", Regular, "", b"top"),
                ("folder/x.txt", Regular, "", b"x"),
            ]),
        )
        .unwrap();
        for folder in [None, Some("folder")] {
            let (code, out) = sh_in(
                &work,
                &extract_script(".", "o.tar", folder, Format::Tar, 60),
            );
            assert_eq!(code, 1, "{:?}: {}", folder, out);
            assert!(out.contains("symbolic link"), "{:?}: {}", folder, out);
            assert_eq!(
                std::fs::read_dir(root.join("elsewhere")).unwrap().count(),
                0,
                "{:?}",
                folder
            );
            assert!(!work.join("top.txt").exists(), "{:?}", folder);
            no_staging_left(&work);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_archive_script_runs() {
        if !have("tar") {
            eprintln!("remote_archive_script_runs: SKIPPED, no sh / tar");
            return;
        }
        let root = temp_root("pack");
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("it's"), b"alpha").unwrap();
        std::fs::write(root.join("folder/b.txt"), b"beta").unwrap();
        let names = strings(&["it's", "folder"]);
        let pack = |overwrite| {
            sh_in(
                &root,
                &archive_script(".", &names, "./o.tar.gz", Format::TarGz, overwrite, 60),
            )
        };
        let (code, out) = pack(false);
        assert_eq!(code, 0, "{}", out);
        assert!(root.join("o.tar.gz").is_file());
        let (code, out) = pack(false);
        assert_eq!(code, 17, "{}", out);
        assert!(out.contains(EXISTS_MARKER));
        assert_eq!(pack(true).0, 0);
        // A folder under the target name is never "replaced".
        std::fs::create_dir_all(root.join("dir.tar")).unwrap();
        let (code, out) = sh_in(
            &root,
            &archive_script(".", &names, "./dir.tar", Format::Tar, true, 60),
        );
        assert_eq!(code, 1, "{}", out);
        assert!(
            out.contains("A folder with that name already exists"),
            "{}",
            out
        );
        assert_eq!(std::fs::read_dir(root.join("dir.tar")).unwrap().count(), 0);
        // A failed run leaves neither the archive nor its temporary file.
        let (code, _) = sh_in(
            &root,
            &archive_script(
                ".",
                &strings(&["missing"]),
                "./bad.tar",
                Format::Tar,
                false,
                60,
            ),
        );
        assert_ne!(code, 0);
        let left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            !left
                .iter()
                .any(|n| n.starts_with("bad.tar") || n.ends_with(".part")),
            "{:?}",
            left
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_names_allow_posix_punctuation() {
        assert!(remote_name_ok("a\\b") && remote_name_ok("a:b") && remote_name_ok("it's"));
        for bad in ["..", "a\\..\\b", "a/b", ".", ""] {
            assert!(!remote_name_ok(bad), "{:?}", bad);
        }
        assert!(check_remote_names(&strings(&["a\\b", "a:b"])).is_ok());
        assert!(check_remote_extract("a\\b.zip", Some("a:b")).is_ok());
    }

    #[test]
    fn scripts_keep_a_changed_archive_and_stop_root_specials() {
        let pack = archive_script(
            "/srv",
            &strings(&["a"]),
            "/srv/o.tar",
            Format::Tar,
            false,
            60,
        );
        assert!(pack.contains("zip/18|tar/1|tar.gz/1"), "{}", pack);
        assert!(pack.contains("[ -e \"$t\" ] || [ -L \"$t\" ]"), "{}", pack);
        let unzip = extract_script("/srv", "a[1].zip", None, Format::Zip, 60);
        assert!(unzip.contains("ln -s --"), "{}", unzip);
        let tar = extract_script("/srv", "a.tar", None, Format::Tar, 60);
        assert!(tar.contains("owner=-o"), "{}", tar);
        assert!(tar.contains("'^[bcp]'"), "{}", tar);
        assert!(tar.contains("'^...[sS]|^......[sS]'"), "{}", tar);
        assert!(tar.contains("chmod -R u+rwx"), "{}", tar);
    }

    #[test]
    fn drive_root_is_writable_and_system_paths_are_not() {
        let root = if cfg!(windows) {
            Path::new(r"C:\")
        } else {
            Path::new("/")
        };
        assert!(refuse_system_write(root).is_ok());
        let blocked = if cfg!(windows) {
            Path::new(r"C:\Windows\none.zip")
        } else {
            Path::new("/etc/none.zip")
        };
        let err = refuse_system_write(blocked).unwrap_err();
        assert!(err.contains("system path"), "{}", err);
    }

    #[test]
    fn extract_refuses_an_autostart_member_and_allows_a_nested_folder() {
        let root = temp_root("policy");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("autostart")).unwrap();
        std::fs::write(src.join("autostart/x.desktop"), b"[Desktop Entry]").unwrap();
        let archive = root.join("o.zip");
        pack_local(
            &src,
            &strings(&["autostart"]),
            &root.join("p"),
            &archive,
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();
        let cfg = root.join(".config");
        std::fs::create_dir(&cfg).unwrap();
        let err =
            extract_local(&cfg, &archive, None, Format::Zip, &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("auto-run"), "{}", err);
        let nested = cfg.join("o");
        std::fs::create_dir(&nested).unwrap();
        extract_local(
            &nested,
            &archive,
            None,
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(nested.join("autostart/x.desktop")).unwrap(),
            b"[Desktop Entry]"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_only_staged_folder_can_be_merged() {
        let root = temp_root("ro-merge");
        let stage = root.join("stage");
        let sub = stage.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a.txt"), b"a").unwrap();
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let meta = std::fs::symlink_metadata(&sub).unwrap();
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(true);
        if std::fs::set_permissions(&sub, perms).is_err() {
            eprintln!(
                "read_only_staged_folder_can_be_merged: SKIPPED, cannot mark the folder read-only"
            );
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        settle_staged(&stage, "").unwrap();
        place_staged(&stage, &dest, "dest").unwrap();
        assert_eq!(std::fs::read(dest.join("sub/a.txt")).unwrap(), b"a");
        remove_stage(&stage);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cancelled_job_writes_nothing() {
        let root = temp_root("cancel-local");
        let src = root.join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        let dest = root.join("o.zip");
        let err = pack_local(
            &src,
            &strings(&["a.txt"]),
            &root.join("p"),
            &dest,
            Format::Zip,
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!dest.exists() && !root.join("p").exists());
        let err =
            extract_local(&root, &dest, None, Format::Zip, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err, CANCELLED);
        no_staging_left(&root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_unzip_reads_a_glob_name_through_a_plain_link() {
        if !have("unzip") {
            eprintln!("remote_unzip_reads_a_glob_name_through_a_plain_link: SKIPPED, no unzip");
            return;
        }
        let root = temp_root("glob-zip");
        let src = root.join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("a.txt"), b"hi").unwrap();
        let packed = root.join("packed.zip");
        pack_local(
            &src,
            &strings(&["a.txt"]),
            &root.join("p"),
            &packed,
            Format::Zip,
            &AtomicBool::new(false),
        )
        .unwrap();
        let work = root.join("work");
        std::fs::create_dir(&work).unwrap();
        std::fs::rename(&packed, work.join("a[1].zip")).unwrap();
        let (code, out) = sh_in(
            &work,
            &extract_script(".", "a[1].zip", Some("out"), Format::Zip, 60),
        );
        assert_eq!(code, 0, "{}", out);
        assert_eq!(std::fs::read(work.join("out/a.txt")).unwrap(), b"hi");
        no_staging_left(&work);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dangling_symlink_counts_as_the_archive() {
        let root = temp_root("dangling-local");
        let link = root.join("gone.tar");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink("missing", &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file("missing", &link);
        if made.is_err() {
            eprintln!("dangling_symlink_counts_as_the_archive: SKIPPED, cannot create a symlink");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        assert!(name_is_present(&link).is_some());
        assert!(!link.exists());
        if have("tar") {
            std::fs::write(root.join("a.txt"), b"a").unwrap();
            let (code, out) = sh_in(
                &root,
                &archive_script(
                    ".",
                    &strings(&["a.txt"]),
                    "./gone.tar",
                    Format::Tar,
                    false,
                    60,
                ),
            );
            assert_eq!(code, 17, "{}", out);
            assert!(out.contains(EXISTS_MARKER), "{}", out);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // A tool that outlives the limit is stopped and reported as
    // KILLED_BY_WATCHDOG; one that finishes is reported with its own code,
    // at once, a SIGTERM from elsewhere included.
    #[test]
    fn watchdog_stops_a_hung_tool() {
        if sh("true").is_none() {
            eprintln!("watchdog_stops_a_hung_tool: SKIPPED, no sh");
            return;
        }
        let started = std::time::Instant::now();
        let (code, out) = sh(&format!("{}; echo rc=$rc", with_watchdog("sleep 60", 1))).unwrap();
        assert_eq!(code, 0, "{}", out);
        assert!(
            out.contains(&format!("rc={}", KILLED_BY_WATCHDOG)),
            "{}",
            out
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(30),
            "{:?}",
            started.elapsed()
        );

        let started = std::time::Instant::now();
        let (_, out) = sh(&format!(
            "{}; echo rc=$rc",
            with_watchdog("sh -c 'exit 3'", 600)
        ))
        .unwrap();
        assert!(out.contains("rc=3"), "{}", out);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );

        let (_, out) = sh(&format!(
            "{}; echo rc=$rc",
            with_watchdog("sh -c 'kill -TERM $$'", 600)
        ))
        .unwrap();
        assert!(
            out.contains("rc=143"),
            "a SIGTERM from elsewhere is not a watchdog stop: {}",
            out
        );
    }
}
