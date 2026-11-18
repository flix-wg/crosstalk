import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { BranchStatus } from "../schema/index.js";
import type { RelayClient } from "./http.js";
import { sequenceRegex } from "./reservations.js";
import { render } from "./render.js";
export interface Update { old: string; new: string; ref: string }
export const zero = (s: string) => /^0+$/.test(s);
export const name = (s: string) => s.replace(/^refs\/heads\//, "");
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } }).trimEnd();
}
export function ancestor(cwd: string, a: string, b: string, timeoutMs = 10000): boolean {
  try {
    execFileSync("git", ["-C", cwd, "merge-base", "--is-ancestor", a, b], { stdio: "ignore", timeout: timeoutMs, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ETIMEDOUT") throw error;
    return false;
  }
}
function duplicateNumbers(paths: string[], regex: RegExp): Map<string, string> {
  const seen = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const path of paths) {
    const match = regex.exec(path);
    if (!match) continue;
    const number = match[1].replace(/^0+(?=\d)/, "");
    const previous = seen.get(number);
    if (previous === undefined) seen.set(number, path);
    else if (!duplicates.has(number)) duplicates.set(number, previous + " and " + path);
  }
  return duplicates;
}

export function duplicateSequence(cwd: string, tree: string, sequences?: Record<string, string>, baseline?: string): string | undefined {
  if (!sequences || !Object.keys(sequences).length) return;
  const paths = (ref: string) => git(cwd, "ls-tree", "-rz", "--name-only", ref).split("\0").filter(Boolean);
  const after = paths(tree), before = baseline ? paths(baseline) : [];
  for (const [sequence, pattern] of Object.entries(sequences)) {
    const regex = sequenceRegex(pattern);
    const existing = duplicateNumbers(before, regex);
    for (const [number, pair] of duplicateNumbers(after, regex)) {
      if (!existing.has(number)) return sequence + " number " + number + " occurs in " + pair;
    }
  }
}

const queueBranch = (ref: string) => ref.replace(/^refs\/(?:heads\/|remotes\/[^/]+\/)/, "").startsWith("gh-readonly-queue/");
export type Source = { source_branch?: string; source_head: string; unknown_source?: true };
export function resolveSources(cwd: string, update: Update, refs: Map<string, string>, protectedBranches: Set<string>): Source[] {
  const tips = (sha: string) => [...refs].filter(([ref, head]) => head === sha && !queueBranch(ref) && !protectedBranches.has(name(ref))).map(([ref]) => ({ source_branch: name(ref), source_head: sha }));
  const direct = tips(update.new);
  if (direct.length) return direct;
  const parents = git(cwd, "rev-list", "--parents", "-n", "1", update.new).split(" ").slice(1);
  if (parents.length > 1 && !zero(update.old) && ancestor(cwd, parents[0], update.old)) {
    return parents.slice(1).flatMap<Source>(head => { const sources = tips(head); return sources.length ? sources : [{ source_head: update.new, unknown_source: true as const }]; });
  }
  return [{ source_head: update.new, unknown_source: true }];
}

/** Missing candidate objects are not reachable; never substitute a different head. */
export function draftSources(cwd: string, update: Update, refs: Map<string, string>, statuses: BranchStatus[], covered: Source[] = []): Source[] {
  const sources: Source[] = [];
  for (const status of statuses) {
    if (queueBranch(status.branch) || !["wip", "draft"].includes(status.state)) continue;
    for (const head of new Set([status.head, refs.get("refs/heads/" + status.branch)])) {
      if (!head || covered.some(s => s.source_branch === status.branch && s.source_head === head)) continue;
      if (!ancestor(cwd, head, update.new) || (!zero(update.old) && ancestor(cwd, head, update.old))) continue;
      sources.push({ source_branch: status.branch, source_head: head });
    }
  }
  return sources;
}
export async function checkMergeSources(client: RelayClient, target: string, sources: Source[]): Promise<{ exitCode: number; stdout: string }> {
  const messages: string[] = [];
  for (const source of sources) {
    const { result } = await client.check({ kind: "merge", ...source, target_branch: target });
    if (!["pass", "warn", "block"].includes(result.verdict)) throw new Error("Invalid gate verdict");
    const message = render({ branch: source.source_branch ?? target, ...result }, { hooks: false });
    if (result.verdict === "block") return { exitCode: 1, stdout: message };
    if (result.verdict === "warn") messages.push(message);
  }
  return { exitCode: 0, stdout: messages.join("\n") };
}

// Relay receipt IDs make repeated post-receive delivery safe across processes,
// crashes and multiple protected branches, without a second notification ledger.
export function stableId(value: string): string { const h = createHash("sha256").update(value).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; }
export async function advance(client: RelayClient, cwd: string, u: Update, seed = false): Promise<void> {
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
