# Changelog

## 0.3.10

### Connect

- A connection asks for a missing password, a key passphrase, or a blank username. An empty username is root. The question stays in that session, and an abandoned attempt does not leave it on screen. Questions wait their turn, and closing one returns focus to what opened it.
- Unencrypted SEC1 and PKCS#8 private keys are accepted, including ECDSA P-521. A key can be generated from the server form.
- Log in with keys from an ssh-agent on this computer: Pageant, the Windows OpenSSH agent, the agent in SSH_AUTH_SOCK, or the one IdentityAgent names in ~/.ssh/config. The saved password or key is tried first. At most three agent keys are offered, and a signature may take up to two minutes. A refused or timed-out signature stops the login. Agent forwarding stays off. Settings has a per-device switch, on by default, and hidden on Android.
- A host key of another kind for the same host and port is treated as a changed key. The prompt stays open while you decide. A key whose bcrypt work factor is above 1024 is refused. Channels the server tries to open are rejected, except a forward this app registered.
- A session is checked with a keepalive ping before a new channel is opened.

### Servers

- Add folder sits next to Add server. Folders nest: the header shows the path, Back goes up, and a server or folder can be dragged into a folder. A folder cannot be moved into itself. Deleting a folder removes its subfolders and their servers. A folder whose parent is missing, or that sits in a loop, stays on the top-level list.

### Files

- Remote file operations can run as root through sudo. The password is sent only to that prompt.
- Deleting a remote folder tries to remove the directory itself before listing it, so a link is not followed. A download refuses a server name that is not a safe local name. A folder download stops past a depth, file-count, and size cap. A finished download replaces the destination by renaming a temporary file.
- A slow transfer stays open while the link is alive, and fails when the session is dead. sudo-rs password and permission errors are recognised. Changing an owner no longer drops setuid bits.
- Local writes are refused in system folders on every drive. Drive roots can be listed. Deleting or renaming a local link changes the link, not the file it points at. A directory link opens as a folder.
- The name filter accepts * and ?. The file list can be driven from the keyboard. Pane headers fit a narrow panel. A drop that lands on a neighboring session is ignored.
- A mirror whose watched folder disappears deletes nothing on the server. The first sync no longer skips a file because a folder was created at the same moment.

### Terminal and sessions

- Pick a terminal font, including seven faces that ship with the app, and any size from 1 to 99.
- Ctrl+Shift+A selects all and Ctrl+Shift+C copies. Plain Ctrl+A and Ctrl+C still reach the shell. Right-click paste uses bracketed paste. On Linux the clipboard is read through GTK, so an empty paste does not crash the terminal.
- Clicking a link asks first, and Open sends only http(s) to the system browser. Pasting more than one line asks when the program has not requested bracketed paste.
- An option starts this computer's shell on the server. This computer's shell config can be pushed to one server on demand.
- The mobile key bar adds arrows, a pipe, and a tilde. Selecting a terminal tab focuses the shell. A tool panel can dock on any side of the terminal and can take the whole session.
- Stopping a forward keeps the rule, and a forward can be named. A name that starts with a dash is refused for a firewall chain, a systemd unit, or a docker object. Setup of a remote forward times out, and each one accepts at most 512 connections at once.

### Sharing and sync

- Sync can use a server you choose, including a self-hosted one, and can go through a proxy. A sign-in is only sent back to the server that issued it. Redirects are refused.
- After the first full sync of an open profile, later rounds send and receive only what changed. Sync bodies are compressed when that server accepts gzip. An older or self-hosted server keeps full, uncompressed rounds.
- Each incoming record is checked before it is merged. A deletion is applied completely or not at all. A reply that arrives after you have switched profiles is discarded.
- A shared profile hands its key only to the account you invite, and only for that profile. A new key waits until you accept its fingerprint. Removing a member re-uploads the profile under the new key.
- On-connect commands, autostart, forwards, and monitor commands that someone else changed stay off until you allow them. A large deletion, or the deletion of any SSH key, waits for the same kind of OK. Importing a host list into a shared profile asks before reading key files.
- MobaXterm sessions are recognised by type. A blank username is saved blank and asked for at connect.

### App

- If a submarine-data folder sits beside the executable and can be written, the app keeps its data there.
- The profile footer has the GitHub link, a manual update check, and the version. Unlock and create errors sit on the field that failed.
- Profiles can be exported and imported on Android. The profile screen fits a small phone.
- The window is opaque, in the app background color. The page no longer tries to resize the operating-system window.
- Icon buttons have names. Tab does not enter a terminal or a panel that is not shown. A row of tabs that does not fit becomes a menu.
- On Linux, the web view's helper process runs in a sandbox when bubblewrap is available.
- Stopping a monitor interrupts a connect or a poll that is already running.

Vault format is unchanged. Existing profiles open without a migration.

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
