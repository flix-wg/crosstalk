import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parse } from "smol-toml";
import { ClientError, RelayClient, credentialScope, loadAgentKey, loadHumanKey } from "../client/index.js";
import type { LoadedConfig } from "../client/index.js";
import { jcs, sha256, validateTicket } from "../schema/index.js";
import type { DeploymentReport, SignedTicket } from "../schema/index.js";

export interface ExecutorConfig extends LoadedConfig { promote: string; live: string; timeout_s: number; ci_key: string; principal: string; stateDir: string }
export interface State { epoch: string | null; max_fence: number; installed: { epoch: string; lease_id: string; fence: number } | null; exec_seq: number; needs_reconcile: boolean }
export interface Op extends Omit<DeploymentReport, "outcome"> { lease_id: string; fingerprint: string; outcome: "started" | DeploymentReport["outcome"]; reported: boolean }
export interface Lock { pid: number; pgid: number; op?: string; since: number; child_pgid?: number }
export function readJSON<T>(file: string): T { return JSON.parse(readFileSync(file, "utf8")) as T; }
export function config(env: string): ExecutorConfig {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(env)) throw new ClientError("usage", "Invalid environment");
  const file = join(process.env.CROSSTALK_EXECUTOR_CONFIG_DIR ?? "/etc/crosstalk/executor", env + ".toml");
  const secure = (path: string) => { const s = statSync(path); if (!s.isFile() || (s.mode & 0o022) || ![0, process.getuid?.()].includes(s.uid)) throw new ClientError("unsafe_config", "Operator files must be owner-controlled"); };
  secure(file);
  const raw = parse(readFileSync(file, "utf8"));
  for (const key of ["space", "relay", "relay_key", "promote", "live", "ci_key"]) if (typeof raw[key] !== "string") throw new ClientError("invalid_config", "Missing executor configuration field " + key);
  for (const key of ["promote", "live", "ci_key"]) { if (!isAbsolute(String(raw[key]))) throw new ClientError("invalid_config", "Operator paths must be absolute"); secure(String(raw[key])); }
  if (typeof raw.timeout_s !== "number" || !Number.isFinite(raw.timeout_s) || raw.timeout_s <= 0) throw new ClientError("invalid_config", "timeout_s must be positive");
  const url = new URL(String(raw.relay));
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ClientError("invalid_config", "Invalid relay origin");
  const principal = readJSON<{ principal: string }>(String(raw.ci_key)).principal;
  if (typeof principal !== "string" || !principal.startsWith("ci:")) throw new ClientError("invalid_config", "CI key file needs its principal");
  const result: ExecutorConfig = { space: String(raw.space), relay: url.origin, relay_key: String(raw.relay_key), promote: String(raw.promote), live: String(raw.live), ci_key: String(raw.ci_key), principal, timeout_s: raw.timeout_s, stateDir: join(process.env.CROSSTALK_EXECUTOR_STATE_DIR ?? "/var/lib/crosstalk/executor", env), sequences: {}, repoDir: dirname(file), commonDir: dirname(file), assertTrusted: () => secure(file), trust: () => result };
  return result;
}
export function client(c: ExecutorConfig, human = false): RelayClient { return new RelayClient(c, { token: human ? loadHumanKey(credentialScope(c)) : loadAgentKey(credentialScope(c), c.ci_key) }); }
export function state(c: ExecutorConfig): State { return existsSync(join(c.stateDir, "state.json")) ? readJSON<State>(join(c.stateDir, "state.json")) : { epoch: null, max_fence: 0, installed: null, exec_seq: 0, needs_reconcile: false }; }
export function operations(c: ExecutorConfig): Op[] { const dir = join(c.stateDir, "ops"); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJSON<Op>(join(dir, f))) : []; }
/** Find the actual inherited descriptor, never trust an environment marker as proof of locking. */
export function lockFD(c: ExecutorConfig): number {
  for (const name of readdirSync("/proc/self/fd")) { try { if (readlinkSync("/proc/self/fd/" + name) === join(c.stateDir, "lock")) {
      const fd = Number(name), stdio: ("ignore" | number)[] = ["ignore", "ignore", "ignore"];
      for (let i = 3; i <= fd; i++) stdio[i] = i === fd ? fd : "ignore";
      execFileSync("flock", ["-n", String(fd)], { stdio }); return fd;
    } } catch { /* Directory enumeration descriptor closed. */ } }
  throw new ClientError("lock_required", "Executor must run under flock");
}
export function durable(c: ExecutorConfig, file: string, value: unknown): void {
  lockFD(c);
  const path = join(c.stateDir, file), temp = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}
/** Process groups with the lock file open: the holder, a detached operator child that inherited it, and waiters. */
export function lockGroups(c: ExecutorConfig): number[] {
  const path = join(c.stateDir, "lock"), groups = new Set<number>();
  for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
    try {
      if (readdirSync(`/proc/${pid}/fd`).some(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === path; } catch { return false; } }))
        groups.add(Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2]));
    } catch { /* Exited or not ours. */ }
  }
  groups.delete(processGroup());
  return [...groups];
}
export function processGroup(): number { return Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ")[2]); }
export function signalGroup(pgid: number, signal: NodeJS.Signals): void { if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === processGroup()) throw new ClientError("invalid_lock", "Unsafe lock process group"); try { process.kill(-pgid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
async function run(c: ExecutorConfig, command: string, args: string[], lock: Lock): Promise<{ ok: boolean; output: string }> {
  const fd = lockFD(c);
  return new Promise(resolve => {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "ignore"];
    for (let i = 3; i <= fd; i++) stdio[i] = i === fd ? fd : "ignore";
    const child = spawn(command, args, { detached: true, stdio });
    let output = "", timedOut = false, finished = false, closed = false, kill: NodeJS.Timeout | undefined;
    if (child.pid) { lock.child_pgid = child.pid; durable(c, "lock.json", lock); }
    let captured = 0, truncated = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = 4096 - captured;
      if (remaining > 0) { output += chunk.subarray(0, remaining).toString(); captured += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining && !truncated) { output += "\n[truncated]"; truncated = true; }
    });
    const stop = () => { timedOut = true; if (child.pid) signalGroup(child.pid, "SIGTERM"); kill ??= setTimeout(() => { if (child.pid) signalGroup(child.pid, "SIGKILL"); kill = undefined; if (closed) done(false); }, 5000); };
    const timer = setTimeout(stop, c.timeout_s * 1000);
    const done = (ok: boolean) => { if (finished || (timedOut && kill)) return; finished = true; clearTimeout(timer); clearTimeout(kill); delete lock.child_pgid; durable(c, "lock.json", lock); resolve({ ok: ok && !timedOut, output }); };
    child.once("error", () => done(false)); child.once("close", code => { closed = true; done(code === 0); });
  });
}
export async function report(c: ExecutorConfig, relay: RelayClient): Promise<void> {
  let pending = false;
  for (const op of operations(c)) if (op.outcome !== "started" && !op.reported) {
    const { env, sha, artifact, fence, exec_seq, live_after, outcome } = op;
    const body = { op: op.op, env, sha, artifact, fence, exec_seq, live_after, outcome };
    try {
    const receipt = await relay.request("/deploy/report", body);
    if (receipt.receipt !== op.op || jcs(receipt.result) !== jcs({ type: "deployment", ...body })) throw new ClientError("invalid_receipt", "Deployment receipt does not match the terminal record");
    durable(c, "ops/" + op.op + ".json", { ...op, reported: true });
    } catch { pending = true; }
  }
  if (pending) throw new ClientError("report_pending", "Terminal records remain queued for reporting");
}
export async function execute(c: ExecutorConfig, env: string, action: string, input: { lease?: string; fence?: number; ticket?: SignedTicket }, lock: Lock): Promise<unknown> {
  lockFD(c); mkdirSync(join(c.stateDir, "ops"), { recursive: true, mode: 0o700 });
  durable(c, "lock.json", lock);
  const relay = client(c), s = state(c), ops = operations(c);
  const save = () => durable(c, "state.json", s);
  let primaryError = false;
  const blocked = () => { if (s.needs_reconcile || ops.some(o => o.outcome === "started")) throw new ClientError("needs_reconcile", "Human reconciliation required"); };
  try {
    if (action === "enroll") {
      if (ops.some(o => o.outcome === "started")) throw new ClientError("needs_reconcile", "Human reconciliation required");
      s.installed = null; save();
      const result = await client(c, true).send("executor.enroll", { env, executor: c.principal, max_fence: s.max_fence });
      s.epoch = result.epoch; save(); return s;
    }
    if (action === "reconcile") {
      const live = await run(c, c.live, [], lock);
      const digest = live.ok && /^sha256:[0-9a-f]{64}\n?$/.test(live.output) ? live.output.trimEnd() : null;
      for (const op of ops) if (op.outcome === "started") durable(c, "ops/" + op.op + ".json", { ...op, outcome: "reconciled", live_after: digest, reported: false });
      s.exec_seq = Math.max(s.exec_seq, ...ops.map(o => o.exec_seq), 0); s.needs_reconcile = digest === null; save();
      if (digest === null) throw new ClientError("needs_reconcile", "live did not return a digest");
      return s;
    }
    if (action === "install") {
      blocked(); if (!s.epoch) throw new ClientError("not_enrolled", "Enroll executor first");
      const lease_id = input.lease!, fence = input.fence!;
      const same = s.installed?.epoch === s.epoch && s.installed.lease_id === lease_id && s.installed.fence === fence;
      const request = { epoch: s.epoch, env, lease_id, fence, max_fence: same ? fence - 1 : s.max_fence };
      if (!same) { await relay.request("/executor/install", { ...request, dry_run: true }); s.max_fence = fence; s.installed = { epoch: s.epoch, lease_id, fence }; save(); }
      await relay.request("/executor/install", { ...request, dry_run: false }); return s;
    }
    if (action !== "promote" || !validateTicket(input.ticket)) throw new ClientError("usage", "A valid signed ticket is required");
    const ticket = input.ticket, t = ticket.payload;
    if (t.env !== env || t.space !== c.space) throw new ClientError("invalid_ticket", "Ticket target mismatch");
    const fingerprint = sha256(jcs({ env, sha: t.sha, artifact: t.artifact, lease_id: t.lease_id, fence: t.fence, op: t.op }));
    const previous = ops.find(o => o.op === t.op);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ClientError("idempotency_mismatch", "Operation payload changed");
      if (previous.outcome !== "started") return previous;
      s.needs_reconcile = true; save();
    }
    blocked();
    if (s.installed?.fence !== t.fence || s.installed.lease_id !== t.lease_id || s.installed.epoch !== s.epoch || t.epoch !== s.epoch) throw new ClientError("stale_fence", "Ticket does not match installed lease and epoch");
    const wall = Date.now(), mono = performance.now(), now = () => wall + performance.now() - mono;
    if (!await relay.verifyRelaySignature(jcs(t), ticket.signature) || t.expires_at <= now()) throw new ClientError("invalid_ticket", "Ticket signature or deadline is invalid");
    const authorization = await relay.request<{ payload: Record<string, unknown>; signature: string }>("/deploy/authorize", { ticket });
    const a = authorization.result;
    if (authorization.epoch !== s.epoch || !await relay.verifyRelaySignature(jcs(a.payload), a.signature) || a.payload.kind !== "deploy_authorization" || typeof a.payload.exec_allowed_until !== "number" || a.payload.exec_allowed_until <= now() || Object.entries(t).some(([key, value]) => !["kind", "expires_at"].includes(key) && a.payload[key] !== value)) throw new ClientError("invalid_authorization", "Authorization signature, fields or deadline invalid");
    s.exec_seq = Math.max(s.exec_seq, ...ops.map(o => o.exec_seq), 0) + 1;
    if (!Number.isSafeInteger(s.exec_seq)) throw new ClientError("sequence_exhausted", "Executor sequence exhausted");
    save();
    const op: Op = { env, op: t.op, sha: t.sha, artifact: t.artifact, lease_id: t.lease_id, fence: t.fence, fingerprint, exec_seq: s.exec_seq, outcome: "started", live_after: null, reported: false };
    durable(c, "ops/" + t.op + ".json", op); lock.op = t.op; durable(c, "lock.json", lock);
    const promoted = await run(c, c.promote, [t.artifact], lock), live = await run(c, c.live, [], lock);
    op.live_after = live.ok && /^sha256:[0-9a-f]{64}\n?$/.test(live.output) ? live.output.trimEnd() : null;
    op.outcome = promoted.ok && op.live_after === t.artifact ? "promoted" : "failed";
    if (!op.live_after) { s.needs_reconcile = true; save(); }
    durable(c, "ops/" + t.op + ".json", op);
    return op;
  } catch (e) { primaryError = true; throw e; }
  finally {
    try { await report(c, relay); } catch (e) { if (!primaryError) throw e; console.error("report_pending: terminal records remain queued"); }
  }
}
