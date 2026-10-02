# Changelog

## 0.3.9

### Files

- Open a remote file in the editor with a progress fill on its row. Opening it again replaces that same local file with the server copy. Saving the local file uploads it back.
- Uploads and downloads share one queue, shown in a bar at the bottom of the file card, with speed, time left, and cancel. A file a transfer is writing is locked so an editor save or a mirror cannot cut it short.
- Opening a file in the editor uses that same bar. Cancelling an upload deletes the remote file when this upload created it, and leaves an existing file in place with a note that it is incomplete.
- The path bar is clickable, including a drive root. The menu lists recent directories and bookmarks stored per profile and per server, separately for the local and remote panes. Deleting a profile drops its bookmarks.
- Drag files and folders onto a directory row, the parent row, or a path segment. A drop in the same pane moves them. A drop on the other pane transfers the selection, including folders.
- Pack a selection into zip, tar, or tar.gz, and extract those archives. Local archives are read in the app. Remote archives use `tar`, `zip`, and `unzip` on the server. Entries that would leave the destination folder are refused.
- Delete a folder and everything inside it. A server-side `rm -rf` runs only when the shell sees the same folder SFTP does. Otherwise an SFTP walk removes the tree. Links are unlinked, never followed. The root and any path with `..` are refused.
- Follow a symbolic link from the file list: folder links open in place, and `..` returns to the directory that held the link.
- Remote rows can show the owner's name, resolved with `id` or `getent`. Columns follow the width of the file pane: owner, rights, then size and changed. What does not fit stays on a second line under the name.
- Copy a file's name or path from the context menu. A selection copies one path per line.
- Changing a directory's permissions no longer sends the file size, which SFTP treated as a truncate and rejected.
- The list shows a parent row, locks while a directory is loading, and shows folder, file, and size totals. File times include seconds. Right-click empty space for the directory menu.

### Sessions

- Terminal, files, tunnels, and the other tools live in the session toolbar. Arrow keys move the highlight. Enter opens the tool.
- Rename a session tab or a terminal tab from a right-click, a double-click, or F2 when focus is outside the terminal.
- Optionally restore the saved servers that were open, including terminal tabs and custom names, the next time the profile is unlocked. The setting is off by default. Quick connect is not restored, and a restored session does not run its connect commands again.
- Command cards are a single row, with icon-only Run, Paste, and Edit.
- A terminal resize that arrives while the PTY is still opening is kept, so the shell is not left one row short. Shell and container terminals share that setup.

### Dependencies

- russh 0.63 and russh-sftp 3, including the fixes for RUSTSEC-2026-0154 and RUSTSEC-2026-0153, plus rustls, Tauri 2.12, and the other Rust upgrades.
- Vault format is unchanged: Argon2id, AES-256-GCM, HKDF-SHA256, and X25519 still produce the same bytes. Existing profiles open without a migration.
- Frontend toolchain: @xterm/xterm 6, Vite 8, TypeScript 6, lucide-react 1, React 19.
