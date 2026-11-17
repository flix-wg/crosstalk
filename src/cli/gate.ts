import { git, name, duplicateSequence, render, ClientError, RelayClient, draftSources, checkMergeSources, resolveSources, advance } from "../client/index.js";
import type { LoadedConfig, CoordinationBoard } from "../client/index.js";
import type { CommandContext } from "./index.js";

/** All connection settings come from the trusted workflow, never the checkout. */
export async function mergeGate(c: CommandContext): Promise<number> {
  let mode: string | undefined;
  try {
    mode = c.args.pos();
    if (mode !== "merge" && mode !== "advance") throw new ClientError("usage", "Expected xt gate merge or advance");
    const relay = c.args.need("relay"), relay_key = c.args.need("relay-key"), space = c.args.need("space");
    const target = name(c.args.need(mode === "advance" ? "ref" : "target"));
    const source = mode === "merge" ? c.args.take("source") : undefined;
    const head = c.args.need(mode === "advance" ? "new" : "head"), base = c.args.need(mode === "advance" ? "old" : "base");
    c.args.done();
    let url: URL;
    try { url = new URL(relay); } catch { throw new ClientError("usage", "Invalid relay URL"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !/^(sha256:[0-9a-f]{64}|ed25519:[A-Za-z0-9+/=_-]+)$/.test(relay_key) ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(space) ||
        ![head, base].every(s => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s)))
      throw new ClientError("usage", "Invalid relay, fingerprint, space or commit SHA");
    try { for (const branch of [target, ...(source === undefined ? [] : [source])]) git(c.cwd, "check-ref-format", "refs/heads/" + branch); }
    catch { throw new ClientError("usage", "Invalid branch name"); }
    const token = process.env.CROSSTALK_KEY;
    if (!token) throw new ClientError("usage", "Set CROSSTALK_KEY to a CI credential");
    const config: LoadedConfig = { relay: url.origin, relay_key, space, sequences: {}, repoDir: c.cwd, commonDir: "", assertTrusted() {}, trust() { return this; } };
    const client = new RelayClient(config, { token, timeoutMs: 5000, retries: 0, signal: AbortSignal.timeout(30000) });
    const who = (await client.request<{ principal: string; kind: string; session?: string }>("/identity")).result;
    if (who.kind !== "ci" || who.session) throw new Error("CI key required");
    if (mode === "advance") {
      if (who.principal !== "ci:remote") throw new Error("ci:remote key required");
      await advance(client, c.cwd, { ref: "refs/heads/" + target, old: base, new: head });
      c.out("crosstalk: reachability reported"); return 0;
    }
    const board = (await client.request<CoordinationBoard>("/board")).result;
    if (!board.coordination.policy) throw new Error("Policy unavailable");
    if (!board.coordination.policy.protected_branches?.some(b => name(b) === target)) {
      c.out("crosstalk: target is not protected; merge gate passes"); return 0;
    }
    for (const sha of [head, base]) git(c.cwd, "cat-file", "-e", sha + "^{commit}");
    const sequences = board.coordination.policy.sequences;
    if (sequences && Object.keys(sequences).length) {
      let tree: string | undefined = head;
      if (source !== undefined) {
        try { tree = git(c.cwd, "merge-tree", "--write-tree", base, head); }
        catch (error) {
          if ((error as { status?: number }).status !== 1) throw error;
          c.out("crosstalk: skipping sequence check because the proposed merge has conflicts");
          tree = undefined;
        }
      }
      if (tree) {
        const duplicate = duplicateSequence(c.cwd, tree, sequences, base);
        if (duplicate) { c.out(render({ error: duplicate }, { hooks: false })); return 1; }
      }
    }
    const refs = new Map<string, string>();
    // CI fetches remote heads; local heads take precedence where both exist.
    for (const prefix of ["refs/remotes/origin/", "refs/heads/"]) {
      for (const line of git(c.cwd, "for-each-ref", "--format=%(refname) %(objectname)", prefix).split("\n").filter(Boolean)) {
        const [ref, sha] = line.split(" ");
        if (ref !== "refs/remotes/origin/HEAD") refs.set("refs/heads/" + ref.slice(prefix.length), sha);
      }
    }
    if (source !== undefined) refs.set("refs/heads/" + source, head);
    refs.set("refs/heads/" + target, head);
    const update = { old: base, new: head, ref: "refs/heads/" + target };
    const protectedBranches = new Set((board.coordination.policy.protected_branches ?? []).map(name));
    const sources = source === undefined ? resolveSources(c.cwd, update, refs, protectedBranches) : [{ source_branch: source, source_head: head }];
    sources.push(...draftSources(c.cwd, update, refs, board.coordination.branches, sources));
    const result = await checkMergeSources(client, target, sources);
    c.out(result.stdout || "crosstalk: merge gate passed"); return result.exitCode;
  } catch (error) {
    if (error instanceof ClientError && error.code === "usage") { c.err(error.message); return mode === "advance" ? 1 : 2; }
    c.err("crosstalk could not confirm the gate"); return 1;
  }
}
