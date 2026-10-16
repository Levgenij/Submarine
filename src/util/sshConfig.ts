// Whether connections use what ~/.ssh/config says about a host: an alias's
// HostName and Port, its User, and IdentityAgent. Per-device and on by
// default; the backend is told at start and whenever the switch changes.
export const USE_SSH_CONFIG_KEY = "submarine-use-ssh-config";

export function readUseSshConfig(): boolean {
  try {
    return localStorage.getItem(USE_SSH_CONFIG_KEY) !== "off";
  } catch {
    return true;
  }
}
