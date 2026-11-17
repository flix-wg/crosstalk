import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig, loadAgentKey, credentialScope, RelayClient, render, Workspace, editConflicts, reservationConflicts, resolveSources, draftSources, checkMergeSources } from "../client/index.js";
import type { CoordinationBoard } from "../client/index.js";
import type { Update } from "../client/index.js";
export type { Update } from "../client/index.js";
export { resolveSources } from "../client/index.js";
export interface GitHookResult { stdout: string; exitCode: number }
export interface GitHookOptions { cwd?: string; client?: RelayClient; advisory?: boolean }
const zero = (s: string) => /^0+$/.test(s);
const name = (s: string) => s.replace(/^refs\/heads\//, "");
function git(cwd: string, ...args: string[]): string { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 64 * 1024 * 1024 }).trim(); }
function ancestor(cwd: string, a: string, b: string): boolean { try { git(cwd, "merge-base", "--is-ancestor", a, b); return true; } catch { return false; } }
export function parseUpdates(input: string | Buffer): Update[] {
  // Git's wire format is bytes, with ASCII separators; Unicode whitespace is a valid ref character.
  const text = Buffer.isBuffer(input) ? input.toString("latin1") : Buffer.from(input).toString("latin1");
  const updates = text.split("\n").filter(Boolean).map(line => {
    const fields = line.split(" ");
    if (fields.length !== 3 || !fields.slice(0, 2).every(s => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s)) || !fields[2].startsWith("refs/")) throw new Error("Invalid ref update");
    // Unrepresentable, unprotected refs remain opaque and never prevent processing other refs.
    const bytes = Buffer.from(fields[2], "latin1");
    let ref: string;
    try { ref = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { ref = (fields[2].startsWith("refs/crosstalk/") ? "refs/crosstalk/" : "") + "opaque:" + bytes.toString("hex"); }
    return { old: fields[0], new: fields[1], ref };
  });
  if (new Set(updates.map(u => u.ref)).size !== updates.length) throw new Error("Duplicate ref update");
  return updates;
}
function remoteClient(cwd: string) {
  const config = loadConfig(cwd); config.assertTrusted();
  return new RelayClient(config, { token: loadAgentKey(credentialScope(config)), timeoutMs: 5000, retries: 0 });
}
function postRefs(cwd: string, updates: Update[]): Map<string, string> {
  const refs = new Map(git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
  for (const u of updates) if (u.ref.startsWith("refs/heads/")) { if (zero(u.new)) refs.delete(u.ref); else refs.set(u.ref, u.new); }
  return refs;
}
export async function runPreReceive(input: string | Buffer | Update[], options: GitHookOptions = {}): Promise<GitHookResult> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const updates = parseUpdates(!Array.isArray(input) ? input : input.map(u => `${u.old} ${u.new} ${u.ref}`).join("\n")), client = options.client ?? remoteClient(cwd);
    const board = (await client.request<CoordinationBoard>("/board")).result;
    if (!board.coordination.policy) throw new Error("Relay policy unavailable; upgrade relay first");
    const protectedBranches = new Set((board.coordination.policy?.protected_branches ?? []).map(name));
    const refs = postRefs(cwd, updates), messages: string[] = [];
    for (const u of updates) {
      if (u.ref.startsWith("refs/crosstalk/")) {
        const who = (await client.request<{ principal: string; role: string; kind: string; session?: string }>("/identity")).result;
        if (!((who.principal === "ci:remote" && who.kind === "ci" && !who.session) || (who.role === "admin" && who.kind === "human" && !who.session)) || zero(u.new) || (!zero(u.old) && !ancestor(cwd, u.old, u.new)))
          return { exitCode: 1, stdout: "crosstalk audit refs require ci:remote/admin and a fast-forward update; deletion is refused" };
      }
      if (!u.ref.startsWith("refs/heads/") || !protectedBranches.has(name(u.ref))) continue;
      if (zero(u.new) || (!zero(u.old) && !ancestor(cwd, u.old, u.new))) return { exitCode: 1, stdout: render({ branch: name(u.ref), error: "Non-fast-forward protected branch update rejected" }, { hooks: false, peer: false }) };
      const sources = resolveSources(cwd, u, refs, protectedBranches);
      sources.push(...draftSources(cwd, u, refs, board.coordination.branches, sources));
      const result = await checkMergeSources(client, name(u.ref), sources);
      if (result.exitCode) return result;
      if (result.stdout) messages.push(result.stdout);
    }
    return { exitCode: 0, stdout: messages.join("\n") };
  } catch { return { exitCode: options.advisory ? 0 : 1, stdout: options.advisory ? "crosstalk: gate checks unavailable" : "crosstalk could not confirm the gate; push rejected" }; }
}
// Relay receipt IDs make repeated post-receive delivery safe across processes,
// crashes and multiple protected branches, without a second notification ledger.
function stableId(value: string): string { const h = createHash("sha256").update(value).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; }
async function advance(client: RelayClient, cwd: string, u: Update, seed = false): Promise<void> {
  const commits = git(cwd, "rev-list", zero(u.old) ? u.new : u.old + ".." + u.new).split("\n").filter(Boolean);
  // 200 SHA-256 IDs plus the envelope fit the 16 KiB request cap.
  for (let i = 0; i < commits.length; i += 200) {
    if (seed) await client.send("ref.seed", { ref: u.ref, commits: commits.slice(i, i + 200) });
    else {
      const args = { ref: u.ref, old: zero(u.old) ? null : u.old, new: u.new, commits: commits.slice(i, i + 200) };
      await client.command({ request_id: stableId(client.config.space + "/advance/" + JSON.stringify(args)), op: "ref.advance", args });
    }
  }
}
export async function runPostReceive(input: string | Buffer | Update[], options: GitHookOptions = {}): Promise<GitHookResult> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const updates = parseUpdates(!Array.isArray(input) ? input : input.map(u => `${u.old} ${u.new} ${u.ref}`).join("\n")), client = options.client ?? remoteClient(cwd);
    const board = (await client.request<CoordinationBoard>("/board")).result;
    if (!board.coordination.policy) throw new Error("Relay policy unavailable; upgrade relay first");
    const protectedBranches = new Set((board.coordination.policy?.protected_branches ?? []).map(name));
    const accepted = updates.filter(u => u.ref.startsWith("refs/heads/") && protectedBranches.has(name(u.ref)) && !zero(u.new));
    const before = postRefs(cwd, updates.map(u => ({ ...u, new: u.old })));
    for (const u of accepted) await advance(client, cwd, u);
    for (const status of board.coordination.branches) {
      if (!status.head || !["wip", "draft"].includes(status.state)) continue;
      const wasReachable = [...before].some(([ref, head]) => protectedBranches.has(name(ref)) && ancestor(cwd, status.head!, head));
      if (wasReachable || !accepted.some(u => ancestor(cwd, status.head!, u.new))) continue;
      const id = stableId(client.config.space + "/draft-merged/" + status.branch + "/" + status.head);
      await client.command({ request_id: id, op: "message.send", args: { to: [status.owner], context_id: id, parts: [{ kind: "text", text: "Draft/wip branch became reachable from a protected branch: " + status.branch + " at " + status.head }] } });
    }
    if (accepted.length && client.config.audit_hook) execFileSync("/bin/sh", ["-c", client.config.audit_hook], { cwd, timeout: 30000, stdio: "ignore" });
    return { exitCode: 0, stdout: "" };
  } catch {
    const text = Array.isArray(input) ? input.map(u => `${u.old} ${u.new} ${u.ref}`).join("\n") : Buffer.isBuffer(input) ? input.toString("utf8") : input;
    if (Buffer.isBuffer(input) && !Buffer.from(text).equals(input)) {
      return { exitCode: 1, stdout: "crosstalk post-receive incomplete; run in this repository:\nprintf '%s' '" + input.toString("base64") + "' | base64 -d | xt hook git post-receive" };
    }
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    return { exitCode: 1, stdout: "crosstalk post-receive incomplete; completed batches are durable. Run in this repository to finish:\nprintf '%s\\n' " + quote(text.trimEnd()) + " | xt hook git post-receive" };
  }
}
export async function runSeed(ref: string, options: GitHookOptions & { client: RelayClient }): Promise<GitHookResult> {
  const cwd = options.cwd ?? process.cwd();
  try {
    if (!ref.startsWith("refs/heads/")) ref = "refs/heads/" + ref;
    const head = git(cwd, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}");
    await advance(options.client, cwd, { old: "0".repeat(40), new: head, ref }, true);
    return { exitCode: 0, stdout: "Reachability seeded" };
  } catch { return { exitCode: 1, stdout: "crosstalk seed failed" }; }
}
export async function runPreCommit(cwd = process.cwd()): Promise<GitHookResult> {
  let w: Workspace | undefined;
  try {
    w = new Workspace(cwd, { timeoutMs: 1500, retries: 0, signal: AbortSignal.timeout(1800) });
    const { client, record } = await w.cliSession();
    const board = (await client.board()).response.result as CoordinationBoard;
    const paths = execFileSync("git", ["-C", cwd, "diff", "--cached", "--name-only", "-z"], { encoding: "utf8", timeout: 1000 }).split("\0").filter(Boolean);
    const added = execFileSync("git", ["-C", cwd, "diff", "--cached", "--diff-filter=A", "--name-only", "-z"], { encoding: "utf8", timeout: 1000 }).split("\0").filter(Boolean);
    const reservations = await reservationConflicts(client, added);
    if (reservations.length) return { exitCode: w.config.strict ? 1 : 0, stdout: render(reservations, { hooks: false }) };
    const conflicts = editConflicts(board, paths, record.session_id);
    return { exitCode: conflicts.length && w.config.strict ? 1 : 0, stdout: conflicts.length ? render({ warning: "Staged paths overlap other sessions' leases", conflicts }, { hooks: false }) : "" };
  } catch { return { exitCode: w?.config.strict ? 1 : 0, stdout: "crosstalk: lease checks unavailable" }; }
  finally { w?.close(); }
}
export async function runPrePush(input: string, cwd = process.cwd()): Promise<GitHookResult> {
  let w: Workspace | undefined;
  try {
    const updates = input.trim().split("\n").filter(Boolean).map(line => {
      const [localRef, newHead, ref, old] = line.trim().split(/\s+/);
      if (!localRef || !newHead || !ref || !old) throw new Error("Invalid pre-push input");
      return { old, new: newHead, ref };
    });
    w = new Workspace(cwd, { timeoutMs: 2000, retries: 0, signal: AbortSignal.timeout(10000) });
    const { client } = await w.cliSession();
    return await runPreReceive(updates, { cwd, client, advisory: !w.config.strict });
  } catch { return { exitCode: !w?.config.strict ? 0 : 1, stdout: !w?.config.strict ? "crosstalk: gate checks unavailable" : "crosstalk could not confirm the gate; push rejected" }; }
  finally { w?.close(); }
}
