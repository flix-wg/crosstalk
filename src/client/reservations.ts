import { execFileSync } from "node:child_process";
import { basename, matchesGlob } from "node:path";
import type { LoadedConfig, SequenceConfig } from "./config.js";
import type { RelayClient } from "./http.js";
import { ClientError } from "./config.js";
type Definition = SequenceConfig | string;
export function sequenceRegex(pattern: string): RegExp {
  return new RegExp("^" + pattern.split(/(\(\\d\+\)|\*)/).map(part =>
    part === "(\\d+)" ? "(\\d+)" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}
function pathMatcher(definition: Definition): (path: string) => RegExpExecArray | null {
  if (typeof definition === "string") {
    const regex = sequenceRegex(definition);
    return path => regex.exec(path);
  }
  const regex = new RegExp(definition.floor_regex);
  return path => matchesGlob(path, definition.floor_glob) ? regex.exec(basename(path)) : null;
}
export function reservationFloor(config: LoadedConfig, sequence: string, policy?: Record<string, string>): number | undefined {
  const key = sequence.replace(/^seq:/, "");
  const definition = policy?.[key] ?? config.sequences[key];
  if (!definition) return;
  const git = (...args: string[]) => execFileSync("git", ["-C", config.repoDir, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  let remote: string | undefined;
  try { remote = git("symbolic-ref", "refs/remotes/origin/HEAD").trim(); } catch { /* No known origin default branch in a fresh clone. */ }
  const paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(remote ? ["--with-tree=" + remote] : []), "--", ...(typeof definition === "string" ? [] : [":(glob)" + definition.floor_glob])).split("\0");
  const matchPath = pathMatcher(definition); let max = 0;
  for (const path of paths) {
    const match = matchPath(path); if (!match) continue;
    const value = Number(match[1] ?? match[0]);
    if (!Number.isSafeInteger(value) || value < 0) throw new ClientError("invalid_config", "Sequence regex must capture a nonnegative integer");
    max = Math.max(max, value);
  }
  if (!Number.isSafeInteger(max + 1)) throw new ClientError("invalid_config", "Sequence floor exceeds safe integers");
  return max + 1;
}


/** Only paths that are about to be created (or staged as added) belong here. */
export async function reservationConflicts(client: RelayClient, paths: string[], policy?: Record<string, string>): Promise<string[]> {
  const candidates: { sequence: string; value: number }[] = [];
  for (const [name, definition] of Object.entries({ ...client.config.sequences, ...policy })) {
    const matchPath = pathMatcher(definition);
    for (const path of paths) {
      const match = matchPath(path);
      if (!match) continue;
      const value = Number(match[1] ?? match[0]);
      if (!Number.isSafeInteger(value) || value < 0) throw new ClientError("invalid_config", "Sequence regex must capture a nonnegative integer");
      candidates.push({ sequence: "seq:" + name, value });
    }
  }
  if (!candidates.length) return [];
  const reservations = (await client.request<{ sequence: string; value: number; abandoned: number }[]>("/reservations")).result;
  return [...new Set(candidates.filter(c => !reservations.some(r => r.sequence === c.sequence && r.value === c.value && !r.abandoned))
    .map(c => "Number " + c.value + " is not reserved by this principal; run xt reserve " + c.sequence))];
}
