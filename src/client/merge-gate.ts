import { execFileSync } from "node:child_process";
import type { BranchStatus } from "../schema/index.js";
import type { RelayClient } from "./http.js";
import { render } from "./render.js";
export interface Update { old: string; new: string; ref: string }
const zero = (s: string) => /^0+$/.test(s);
const name = (s: string) => s.replace(/^refs\/heads\//, "");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } }).trim();
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
export type Source = { source_branch?: string; source_head: string; unknown_source?: true };
export function resolveSources(cwd: string, update: Update, refs: Map<string, string>, protectedBranches: Set<string>): Source[] {
  const tips = (sha: string) => [...refs].filter(([ref, head]) => head === sha && !protectedBranches.has(name(ref))).map(([ref]) => ({ source_branch: name(ref), source_head: sha }));
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
    if (!["wip", "draft"].includes(status.state)) continue;
    for (const head of new Set([status.head, refs.get("refs/heads/" + status.branch)])) {
      if (!head || covered.some(s => s.source_branch === status.branch && s.source_head === head)) continue;
      if (ancestor(cwd, head, update.new) && (zero(update.old) || !ancestor(cwd, head, update.old)))
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
