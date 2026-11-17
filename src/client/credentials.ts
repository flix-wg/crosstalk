import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ClientError } from "./config.js";

function fileKey(file: string, scope: string): string {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ClientError("credentials_unavailable", "Credential file is unavailable"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))
      throw new ClientError("unsafe_credentials", "Credential file must be owned by you with mode 0600");
    const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const key = data && typeof data === "object" ? (data as Record<string, unknown>)[scope] : undefined;
    if (typeof key !== "string" || key.length < 32) throw new Error();
    return key;
  } catch (e) {
    if (e instanceof ClientError) throw e;
    throw new ClientError("credentials_unavailable", "No valid credential for this scope");
  } finally { closeSync(fd); }
}
/** Agent adapters use this entry point; it never consults human key stores. */
export function loadAgentKey(scope: string, file = join(homedir(), ".config/crosstalk/credentials.json")): string {
  return fileKey(file, scope);
}
/** Human-only entry point for a future controlling-terminal CLI flow. */
export function loadHumanKey(scope: string, options: { file?: string; warn?: (message: string) => void } = {}): string {
  const command = process.platform === "darwin" ? "security" : "secret-tool";
  const args = command === "security" ? ["find-generic-password", "-s", "crosstalk", "-a", scope, "-w"] : ["lookup", "service", "crosstalk", "account", scope];
  try {
    const key = execFileSync(command, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (key.length < 32) throw new ClientError("credentials_unavailable", "Human key is absent from keychain");
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ClientError("credentials_unavailable", "Cannot load human key from keychain");
  }
  (options.warn ?? console.warn)("System keychain unavailable; using a mode 0600 human credential file");
  return fileKey(options.file ?? join(homedir(), ".config/crosstalk/human-credentials.json"), scope);
}
