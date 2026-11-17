import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { LoadedConfig } from "./config.js";
import { ClientError } from "./config.js";
export function reservationFloor(config: LoadedConfig, sequence: string): number | undefined {
  const definition = config.sequences[sequence.replace(/^seq:/, "")];
  if (!definition) return;
  const git = (...args: string[]) => execFileSync("git", ["-C", config.repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let remote: string | undefined;
  try { remote = git("symbolic-ref", "refs/remotes/origin/HEAD").trim(); } catch { /* No known origin default branch in a fresh clone. */ }
  const paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(remote ? ["--with-tree=" + remote] : []), "--", ":(glob)" + definition.floor_glob).split("\0");
  const regex = new RegExp(definition.floor_regex); let max = 0;
  for (const path of paths) {
    const match = regex.exec(basename(path)); if (!match) continue;
    const value = Number(match[1] ?? match[0]);
    if (!Number.isSafeInteger(value) || value < 0) throw new ClientError("invalid_config", "Sequence regex must capture a nonnegative integer");
    max = Math.max(max, value);
  }
  if (!Number.isSafeInteger(max + 1)) throw new ClientError("invalid_config", "Sequence floor exceeds safe integers");
  return max + 1;
}
