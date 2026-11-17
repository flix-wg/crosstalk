import { execFileSync } from "node:child_process";
import { ClientError, RelayClient, draftSources, checkMergeSources } from "../client/index.js";
import type { LoadedConfig, CoordinationBoard } from "../client/index.js";
import type { CommandContext } from "./index.js";

/** All connection settings come from the trusted workflow, never the checkout. */
export async function mergeGate(c: CommandContext): Promise<number> {
  try {
    if (c.args.pos() !== "merge") throw new ClientError("usage", "Expected xt gate merge");
    const relay = c.args.need("relay"), relay_key = c.args.need("relay-key"), space = c.args.need("space");
    const target = c.args.need("target"), source = c.args.need("source"), head = c.args.need("head"), base = c.args.need("base");
    c.args.done();
    let url: URL;
    try { url = new URL(relay); } catch { throw new ClientError("usage", "Invalid relay URL"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !/^(sha256:[0-9a-f]{64}|ed25519:[A-Za-z0-9+/=_-]+)$/.test(relay_key) ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(space) ||
        ![head, base].every(s => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s)))
      throw new ClientError("usage", "Invalid relay, fingerprint, space or commit SHA");
    const git = (...args: string[]) => execFileSync("git", ["-C", c.cwd, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } }).trim();
    try { for (const branch of [source, target]) git("check-ref-format", "refs/heads/" + branch); }
    catch { throw new ClientError("usage", "Invalid branch name"); }
    const token = process.env.CROSSTALK_KEY;
    if (!token) throw new ClientError("usage", "Set CROSSTALK_KEY to a CI credential");
    const config: LoadedConfig = { relay: url.origin, relay_key, space, sequences: {}, repoDir: c.cwd, commonDir: "", assertTrusted() {}, trust() { return this; } };
    const client = new RelayClient(config, { token, timeoutMs: 5000, retries: 0, signal: AbortSignal.timeout(30000) });
    const who = (await client.request<{ kind: string; session?: string }>("/identity")).result;
    if (who.kind !== "ci" || who.session) throw new Error("CI key required");
    const board = (await client.request<CoordinationBoard>("/board")).result;
    if (!board.coordination.policy) throw new Error("Policy unavailable");
    if (!board.coordination.policy.protected_branches?.some(b => b.replace(/^refs\/heads\//, "") === target)) {
      c.out("crosstalk: target is not protected; merge gate passes"); return 0;
    }
    for (const sha of [head, base]) git("cat-file", "-e", sha + "^{commit}");
    const refs = new Map<string, string>();
    // CI fetches remote heads; local heads take precedence where both exist.
    for (const prefix of ["refs/remotes/origin/", "refs/heads/"]) {
      for (const line of git("for-each-ref", "--format=%(refname) %(objectname)", prefix).split("\n").filter(Boolean)) {
        const [ref, sha] = line.split(" ");
        refs.set("refs/heads/" + ref.slice(prefix.length), sha);
      }
    }
    refs.set("refs/heads/" + source, head);
    refs.set("refs/heads/" + target, head);
    const primary = { source_branch: source, source_head: head };
    const sources = [primary, ...draftSources(c.cwd, { old: base, new: head, ref: "refs/heads/" + target }, refs, board.coordination.branches, [primary])];
    const result = await checkMergeSources(client, target, sources);
    c.out(result.stdout || "crosstalk: merge gate passed"); return result.exitCode;
  } catch (error) {
    if (error instanceof ClientError && error.code === "usage") { c.err(error.message); return 2; }
    c.err("crosstalk could not confirm the gate"); return 1;
  }
}
