import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";

export class ClientError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = "ClientError"; }
}
export interface SequenceConfig { floor_glob: string; floor_regex: string; restore_gap?: number }
export interface ConfigValues { space: string; relay: string; relay_key: string; sequences: Record<string, SequenceConfig>; edit_conflict?: "warn" | "ask"; strict?: boolean; auto_claim?: boolean; audit_hook?: string }
function git(repo: string, ...args: string[]) {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { throw new ClientError("not_repository", "Not inside a git repository: " + repo); }
}
function values(repo: string): ConfigValues {
  if (!existsSync(join(repo, ".crosstalk.toml"))) throw new ClientError("missing_config", "no .crosstalk.toml in " + repo + "; run `xt init`");
  let raw: Record<string, unknown>;
  try { raw = parse(readFileSync(join(repo, ".crosstalk.toml"), "utf8")); }
  catch { throw new ClientError("invalid_config", "Cannot parse .crosstalk.toml"); }
  const { space, relay, relay_key } = raw;
  if (typeof space !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(space) ||
    typeof relay !== "string" || typeof relay_key !== "string" || !/^(sha256:[0-9a-f]{64}|ed25519:[A-Za-z0-9+/=_-]+)$/.test(relay_key))
    throw new ClientError("invalid_config", "Config needs space UUID, relay URL and relay_key fingerprint");
  let url: URL;
  try { url = new URL(relay); } catch { throw new ClientError("invalid_config", "Invalid relay URL"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new ClientError("invalid_config", "Relay must be an HTTPS origin (HTTP only on loopback)");
  const sequences = raw.sequences ?? {};
  if (!sequences || typeof sequences !== "object" || Array.isArray(sequences)) throw new ClientError("invalid_config", "Invalid sequences");
  for (const sequence of Object.values(sequences)) {
    if (!sequence || typeof sequence !== "object" || Array.isArray(sequence) ||
      typeof sequence.floor_glob !== "string" || typeof sequence.floor_regex !== "string" ||
      (sequence.restore_gap !== undefined && (!Number.isSafeInteger(sequence.restore_gap) || Number(sequence.restore_gap) < 0)))
      throw new ClientError("invalid_config", "Sequence needs floor_glob, floor_regex and optional nonnegative restore_gap");
    try { new RegExp(sequence.floor_regex); } catch { throw new ClientError("invalid_config", "Invalid sequence floor_regex"); }
  }
  if (raw.edit_conflict !== undefined && !["warn", "ask"].includes(String(raw.edit_conflict))) throw new ClientError("invalid_config", "edit_conflict must be warn or ask");
  for (const key of ["strict", "auto_claim"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new ClientError("invalid_config", key + " must be boolean");
  if (raw.audit_hook !== undefined && typeof raw.audit_hook !== "string") throw new ClientError("invalid_config", "audit_hook must be a command string");
  return { edit_conflict: raw.edit_conflict as "warn" | "ask" | undefined, strict: raw.strict as boolean | undefined, auto_claim: raw.auto_claim as boolean | undefined, audit_hook: raw.audit_hook as string | undefined, space, relay: url.origin, relay_key, sequences: sequences as Record<string, SequenceConfig> };
}
const pin = (v: ConfigValues) => JSON.stringify({ space: v.space, relay: v.relay, relay_key: v.relay_key, audit_hook: v.audit_hook });
export interface LoadedConfig extends ConfigValues {
  repoDir: string;
  commonDir: string;
  assertTrusted(): void;
  trust(): LoadedConfig;
}
export function loadConfig(repoDir: string): LoadedConfig {
  const root = git(repoDir, "rev-parse", "--is-bare-repository") === "true" ? git(repoDir, "rev-parse", "--absolute-git-dir") : git(repoDir, "rev-parse", "--show-toplevel");
  const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const current = values(root);
  const file = join(commonDir, "crosstalk", "trust.json");
  const changed = (): never => {
    let commit = "uncommitted";
    try { commit = git(root, "log", "-1", "--format=%H", "--", ".crosstalk.toml") || commit; } catch { /* Initial repository. */ }
    throw new ClientError("config_changed", "crosstalk config changed in " + commit + "; a human must run `xt trust`");
  };
  return {
    ...current, repoDir: root, commonDir,
    assertTrusted() {
      let saved: string;
      try { saved = readFileSync(file, "utf8"); } catch { return changed(); }
      let latest: ConfigValues;
      try { latest = values(root); } catch { return changed(); }
      if (saved !== pin(latest) || pin(current) !== pin(latest)) changed();
    },
    trust() {
      const latest = values(root);
      mkdirSync(join(commonDir, "crosstalk"), { recursive: true, mode: 0o700 });
      const temp = file + "." + randomUUID();
      writeFileSync(temp, pin(latest), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
      return loadConfig(root);
    },
  };
}
export function trust(repoDir: string): LoadedConfig { return loadConfig(repoDir).trust(); }
