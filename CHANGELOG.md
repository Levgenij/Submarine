# Changelog

## 0.4.0

### Connect

- Key exchange also offers the NIST curves, P-256, P-384, and P-521, after X25519 and before the finite-field groups. SHA-1 group exchange sits with the other SHA-1 exchanges, after every SHA-2 one. A server that offers only one of these can connect. MLKEM and Curve25519 stay first.
- Keyboard-interactive gives up after 20 empty rounds. Telnet through an SSH server gives the channel 15 seconds to open. An HTTP proxy host is checked before CONNECT and has to be a host name, with no spaces or line breaks.
- PuTTY and PKCS#8 keys are refused when the cost in the key header is too high, before the passphrase is tried. OpenSSH bcrypt still stops above 1024 rounds. Exactly 1024 is still allowed.
- A ProxyCommand host written as an IPv6 address in brackets is passed without the brackets. Any other bracket in the host is refused and nothing runs.
- The connect log lists the first notes from ~/.ssh/config, then one line that further lines were skipped.

### Servers

- A Telnet server opens in a terminal tab, directly or through an SSH server. It is not encrypted, and the form, the list, the tab, and the log say so. The saved-password button types the password and does not press Enter. Telnet is not monitored and does not autostart.
- A VNC server shows its screen in the tab, directly or through an SSH server. The saved password is used, or the tab asks when the server wants one. The password is not written to the log. A direct connection is marked not encrypted. Through an SSH server, only the hop after that server is called not encrypted. VNC is not monitored, not autostarted, and not a jump host.
- Open in for an RDP server stays this computer's RDP app. A built-in client in the tab is optional and marked experimental. On a phone the tab offers it and does not connect until it is chosen. The certificate is pinned on its own and checked before any secret is sent.
- VNC and the built-in RDP client hold the next frame while the page is still drawing, so a slow window does not pile up pictures.
- Tag colours add more swatches, and a last swatch opens the system colour picker. A saved colour that is not one of the swatches is shown on that swatch. The list still paints whatever colour is saved.
- Copying a server also copies the approval hold on its on-connect command and forwards. If the original is still waiting, the copy waits and does not run them. Autostart stays off on the copy. Monitor-command holds stay on the original.
- A service action quotes the unit name, so a systemd instance name that contains a backslash reaches systemctl as written.

### Files

- Files, Mirror, Compare, and the Local / Remote / Split / Side switch keep their words only while the bar is wide enough. Below that every control is an icon, and its name is the tooltip.
- Double-clicking a remote file looks at the real name before anything is downloaded. A program is not opened. The message says to download it and run it only if you trust it. A script Windows would run opens in Notepad. .js, .ps1, .py, and .sh open in Notepad only when Windows would run them. An editor you set for those still gets them. Case, trailing dots and spaces, and a right-to-left mark do not change the type. Saving a file you are already editing is unchanged.
- A mirror folder is refused when it is a network path or a device path. A normal drive path still works, and system folders stay refused.
- A local rename or move does not replace a file or folder that is already there. Renaming a file to another spelling of its own name still works.

### Terminal

- The shell size is sent once it has held still for a moment. A size replaced before that is not sent. While a Wall tile is open, that tile is the one that waits and sends, and the session tab sends nothing.
- If the view is already at the bottom, a resize puts it back there. A view you scrolled up stays where it is.
- The Wall can show 1 to 4 rows, or as many as the tiles need. Each row has its own height, so pinning more tiles resizes the rows. One tile still fills the screen.
- Control characters are left out of a paste. Tab and line breaks stay. The terminal says when something was left out.
- Escape sequences with a huge parameter are cut down before they reach the page, so a hostile server cannot hang the window. Colours, the alternate screen, titles, and images pass through.

### Sharing

- A sync reply stops at 64 MB. Other API reads stop at 1 MB, an error body at 16 KB, and the update check at 8 MB. A declared length over the limit is refused before the body is read, and gzip is counted after it unpacks. Redirects stay refused.
- A synced server's tunnels and mirrors are kept only when they are a list of objects, including each forward's name and whether it is stopped. A bare object, a list of numbers or strings, or broken JSON is refused.
- MobaXterm import stays quick when thousands of sessions share one name. PuTTY session names are read as UTF-8, so an accented or non-Latin name comes out as typed. A name from an older PuTTY that is not UTF-8 keeps one character per byte.

### App

- Minimize, Maximize, and Close stay on a narrow PC window. Android never shows them, including sideways, and a double tap on the bar does not maximize.
- On Windows, the page is allowed to call the app at the address those calls use.
- A profile can be unlocked with Windows Hello or a fingerprint. It stays off until you turn it on for that profile on this device, which asks for the password once. The password is not stored. The sealed key sits outside the vault, so export, sync, and backup do not take it. Windows uses a Hello key in the TPM and hides the feature when there is no TPM. Android uses a key that needs a strong biometric. Linux and macOS are not offered it. A vault that cannot be read, because it is busy or the path did not answer, does not delete the Hello key. Only a vault that is gone does. Deleting the profile removes the file. Portable mode keeps it under submarine-data.
- One window holds a profile. A second window is told the profile is open elsewhere. Other profiles still open. Deleting a profile another window has open is refused. A wrong password or a reload does not leave it locked.
- A profile file past 65 MB is refused before it is read. Import does not overwrite a profile file that already has that name. Export refuses the profile's own file.
- Locking or switching a profile stops every status check, including one still waiting on a server that never answers. A connect that does not answer is given up after four times the connect timeout, and a poll after three times the poll timeout. The host is then reported down.

### Dependencies

- rustls 0.23.46, for sync and the update check, and zip 9.0.5. An archive entry that points outside the destination is still refused.

Vault format is unchanged. Existing profiles open without a migration.

## 0.3.11

### Connect

- Settings can follow ~/.ssh/config. Include and Match are read, with a limit on depth and on how many files are opened. A Match block that would run a command is skipped, and the connect log says so. An alias takes HostName and Port from the block that matched the address, and User only when the server has none saved. The switch is on unless this device stored off, and it is hidden on Android. Turning it off reads nothing, including IdentityAgent. The ssh-agent switch still stops every agent contact.
- A ProxyCommand from that config is the transport when the server has no jump host and no SOCKS or HTTP proxy. ProxyCommand none stays direct. A host or user that a shell would treat specially is refused and nothing runs. The handshake may take two minutes, and the process stops with the connection.
- A ProxyJump list is a chain of hops, at most 8, and a bad list connects nothing. Each hop uses its own alias. The first hop may use its own ProxyCommand or ProxyJump. Later hops go through the one before. A saved jump host and a SOCKS or HTTP proxy win, and that saved jump host can still use the config. Host keys are checked on every hop.
- The monitor never runs a ProxyCommand or follows a ProxyJump, and it does not count that server as down.
- IdentityFile and CertificateFile log in before the agent. IdentitiesOnly leaves the agent out. An RSA certificate uses the hash the server asks for. A key listed in known_hosts, including a hashed line, is trusted with no first-time prompt. A different listed key still goes through the changed-key check. A revoked key is refused. Those files are only read. The monitor still has no prompt and does not read key files.
- A single hidden keyboard-interactive password question is answered once with the saved password. If the server rejects it, you are asked. Codes, PINs, tokens, and echoed questions still ask.
- A timeout, a refusal, an unreachable server, or a broken link is tried again every 5 seconds, including through a jump host. A rejected or cancelled login, a host key that was not approved, no common algorithm, and a setting that cannot be used are not. Cancel stops the cycle. After the session has been up, the terminals stay.
- The first connect waits until the session is listening for the result. On-connect commands are typed once the first terminal is open. Held commands stay held until you allow them.

### Servers

- An RDP server opens this computer's RDP app. The file has the address and the user, and the app asks for the password. Full screen or a window, the clipboard, and shared drives are options on this device. A host with a space, a control character, or a leading dash is refused before any file or command. An SSH server can carry the connection. An RDP server is not a jump host, is not monitored, and does not autostart. A sync edit from an older app keeps the local protocol. On Android they are listed, and they open on a computer.

### Files

- A server with no SFTP program says so at once, before the handshake. A channel that ends at once says the program is missing. The sudo path still says when its own SFTP server is missing.
- When the SFTP subsystem is missing, listings and transfers go through one fixed shell command. The remote pane shows Shell. A sudo refusal is not tried again. The sudo sftp-server path stays when the subsystem exists.
- Compare marks the local and remote panes by name: only here, another kind, another size, or newer or older when the times are more than 2 seconds apart. Hiding files that are the same leaves every folder.

### Terminal

- Each terminal keeps 10,000 lines unless Terminal settings set 1,000 to 50,000 for this device. A typed number applies on Enter or blur. Open terminals pick up a change.
- Terminal settings offer the current colours and named schemes, or a scheme pasted from Windows Terminal. A colour that is not a #hex value is rejected and the scheme already in use stays. Bold in bright colours is on. Keep text readable is off. Open terminals, including a Wall tile, pick the change up at once.
- At a sudo or su prompt the terminal shows Saved password. Nothing is typed until you press it. This server's saved password, or the saved login's when the server uses one, is typed with no Enter. A password with a line break, a carriage return, or a null is not typed, and the password does not reach the window. A quick connect and a container shell do not show the button.
- While a terminal is pinned to the Wall, the tile sets the shell size and the session tab does not. When the last tile closes, the tab sends its own size.
- The phone key bar adds slash and dash. A tap goes through the terminal, so an armed modifier still applies.

### Library

- A saved command can be for every server, or for the servers and folders ticked in its form. A ticked folder includes the servers inside it and the folders under it. In a session, the Library shows that server's commands first, then the ones for every server, and hides the rest. An edit from an older app keeps the choice.

### App

- The window minimum is 480 by 320, so a tiled window can snap. The desktop rail scrolls, so Lock and Settings stay reachable.
- On Android, export saves through the system picker. The copy stays in the app cache and is removed after a save, a cancel, or a failed write. Recents shows no snapshot on Android 13 and later. Block screenshots is off by default, and that setting is only on Android.

Vault format is unchanged. Existing profiles open without a migration.

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
