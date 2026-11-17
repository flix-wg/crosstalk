import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SessionInput } from "../schema/index.js";
import { loadConfig, ClientError } from "./config.js";
import type { LoadedConfig } from "./config.js";
import { loadAgentKey } from "./credentials.js";
import { LocalCache } from "./cache.js";
import type { ClientOptions } from "./http.js";
import { RelayClient } from "./http.js";

export const credentialScope = (config: LoadedConfig) => config.relay + "/" + config.space;
export function gitIdentity(repo: string): { branch: string | null; head: string | null } {
  const git = (...args: string[]) => { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } };
  return { branch: git("symbolic-ref", "--short", "HEAD"), head: git("rev-parse", "--verify", "HEAD") };
}
export interface SessionRecord { session_id: string; token: string; expires_at: string }
export class Workspace {
  readonly config: LoadedConfig;
  readonly cache: LocalCache;
  private readonly key: string;
  constructor(repo: string, private readonly transport: Omit<ClientOptions, "token" | "cache"> = {}, cacheOptions: { fastMetadata?: boolean } = {}) {
    this.config = loadConfig(repo);
    this.config.assertTrusted();
    this.key = loadAgentKey(credentialScope(this.config));
    // Credential fingerprint isolates different principals without storing their key in the cache scope.
    this.cache = new LocalCache(this.config.commonDir, credentialScope(this.config) + "/" + createHash("sha256").update(this.key).digest("hex"), cacheOptions);
  }
  async session(tool: SessionInput["tool"], harness: string, now = Date.now(), cacheHarness: string = tool): Promise<{ client: RelayClient; record: SessionRecord }> {
    const key = this.config.repoDir + "/" + cacheHarness + "/" + harness;
    const owner = randomUUID(), deadline = Date.now() + 10000;
    while (!this.cache.lock(key, owner, Date.now())) {
      this.transport.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new ClientError("session_busy", "Another process is opening this session; retry shortly");
      await sleep(50, undefined, { signal: this.transport.signal });
    }
    try {
      let record = this.cache.get<SessionRecord>("session:" + key);
      if (record) {
        const client = new RelayClient(this.config, { ...this.transport, token: record.token, cache: this.cache });
        try { await client.heartbeat(record.session_id); record.expires_at = new Date(now + 86400000).toISOString(); this.cache.strict(() => this.cache.set("session:" + key, record)); return { client, record }; }
        catch (e) {
          if (e instanceof ClientError && e.code === "unknown") return { client, record };
          if (!(e instanceof ClientError) || e.code !== "unauthenticated") throw e;
        }
      }
      if (record) this.cache.discardOutbox("sha256:" + createHash("sha256").update(record.token).digest("hex"));
      const initial = new RelayClient(this.config, { ...this.transport, token: this.key });
      record = (await initial.request<SessionRecord>("/sessions", { tool, harness_session_id: harness, machine: hostname(), worktree: this.config.repoDir, ...gitIdentity(this.config.repoDir) })).result;
      this.cache.strict(() => this.cache.set("session:" + key, record!));
      return { client: new RelayClient(this.config, { ...this.transport, token: record.token, cache: this.cache }), record };
    } finally { this.cache.unlock(key, owner); }
  }
  cliSession() { return this.session("cli", "cli"); }
  hookSession(tool?: string) {
    const latest = this.cache.get<{ id: string; at: number; tool: string }>("hook:" + this.config.repoDir + (tool ? "/" + tool : ""))
      ?? this.cache.get<{ id: string; at: number; tool: string }>("hook:" + this.config.repoDir);
    return !tool || latest?.tool === tool ? latest : undefined;
  }
  recordHook(id: string, tool: string, at = Date.now()): void {
    const hook = { id, tool, at };
    this.cache.setNewest("hook:" + this.config.repoDir, hook);
    this.cache.setNewest("hook:" + this.config.repoDir + "/" + tool, hook);
    this.markActivity(id, at);
  }
  /** When a harness session's SessionEnd hook ran (0 if never). */
  ended(id: string): number { return this.cache.get<number>("ended:" + this.config.repoDir + "/" + id) ?? 0; }
  markEnded(id: string, at = Date.now()): void { this.cache.set("ended:" + this.config.repoDir + "/" + id, at); }
  activity(id: string): number { return this.cache.get<number>("activity:" + this.config.repoDir + "/" + id) ?? 0; }
  markActivity(id: string, at = Date.now()): void { this.cache.set("activity:" + this.config.repoDir + "/" + id, at); }
  close(): void { this.cache.close(); }
}
export const fallbackHarnessId = () => "mcp:" + randomUUID();

/** Resolve an agent-supplied revision in its worktree before strict relay validation. */
export function branchArguments(cwd: string, args: Record<string, unknown>): void {
  if (!["wip", "draft", "ready"].includes(String(args.state)))
    throw new ClientError("invalid_request", "Invalid branch state; allowed states: wip, draft, ready");
  if (typeof args.head !== "string") throw new ClientError("invalid_request", "Branch head must be a Git revision");
  try { args.head = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "--end-of-options", args.head + "^{commit}"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new ClientError("invalid_request", "Cannot resolve branch head to a commit in this worktree"); }
}
