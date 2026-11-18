import { readFileSync, statSync, existsSync } from "node:fs";
import type { Event } from "../schema/index.js";
import type { SessionRecord } from "../client/index.js";
import { jcs, validateTicket } from "../schema/index.js";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { appendFileSync } from "node:fs";
import { Workspace, ClientError, render, hookDigest, ASK_REMINDER, gitIdentity, editConflicts, ancestor, reservationConflicts } from "../client/index.js";
import type { CoordinationBoard } from "../client/index.js";
import { classifyShell, segments } from "./shell.js";
import { harnessAdapter } from "../client/index.js";
import type { HookOutput } from "../client/index.js";
export type { Harness } from "../client/index.js";
export interface HookResult { stdout: string; exitCode: number }
/** Opt-in operator log: one JSON line per hook run, including errors the hook turned into offline output. */
export async function runHook(harness: string, event: string, stdin: string, startedAt = performance.timeOrigin): Promise<HookResult> {
  const swallowed: { error?: unknown; skipped?: number; timings: Record<string, number> } = { timings: { startup_ms: Math.round(Date.now() - startedAt), relay_ms: 0, relay_requests: 0 } };
  const result = await runHookInner(harness, event, stdin, startedAt, swallowed);
  const file = process.env.CROSSTALK_HOOK_LOG;
  if (file) {
    const e = swallowed.error;
    const line = { at: new Date().toISOString(), harness, event, ms: Math.round(Date.now() - startedAt), pid: process.pid, timings: swallowed.timings,
      ...(e ? { error: e instanceof ClientError ? e.code : e instanceof Error ? e.name : "unknown", message: e instanceof Error ? e.message.slice(0, 300) : undefined } : {}),
      ...(swallowed.skipped ? { cache_writes_skipped: swallowed.skipped } : {}), output: result.stdout.slice(0, 200) };
    try { appendFileSync(file, JSON.stringify(line) + "\n"); } catch { /* logging must never break a hook */ }
  }
  return result;
}
async function runHookInner(harness: string, event: string, stdin: string, startedAt: number, swallowed: { error?: unknown; skipped?: number; timings: Record<string, number> }): Promise<HookResult> {
  const adapter = harnessAdapter(harness), generic = adapter.event(event);
  if (!generic) throw new ClientError("usage", "Unknown hook event " + event);
  const output = (context?: string, decision?: HookOutput["decision"], reason?: string): HookResult => ({ exitCode: 0, stdout: adapter.encode(generic, { context, decision, reason }) });
  let workspace: Workspace | undefined;
  let gate = generic === "before_action";
  let paths: string[] = [], sessionId: string | undefined, digestKey: string | undefined;
  const budget = generic === "session_end" ? 800 : generic === "before_action" ? 1500 : generic === "session_start" ? 1900 : 900;
  const deadline = Math.floor(startedAt + budget);
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())));
  const onRequest = (ms: number) => { swallowed.timings.relay_ms += Math.round(ms); swallowed.timings.relay_requests++; };
  const transport = { signal, timeoutMs: budget, retries: 0, ...(process.env.CROSSTALK_HOOK_LOG ? { onRequest } : {}) };
  try {
    const input = adapter.parse(generic, stdin);
    const actions = input.action.kind === "shell" ? classifyShell(input.action.command, input.cwd) : [];
    gate = actions.length > 0;
    if (actions.some(a => a.kind === "human")) return output(undefined, "deny", "crosstalk: human-only xt command; ask your developer to run it in a terminal");
    const unknownOption = actions.find(a => a.unknownOption)?.unknownOption;
    if (unknownOption) return output(undefined, "deny", "crosstalk could not understand option " + unknownOption + "; use supported options or ask your developer to run the command; remote git hooks still apply");
    // Until trusted config is loaded, a shell command may match a deploy rule.
    gate = input.action.kind === "shell";
    const opening = performance.now();
    workspace = new Workspace(input.cwd, transport, { fastMetadata: true });
    swallowed.timings.workspace_ms = Math.round(performance.now() - opening);
    const w = workspace;
    const deployEnvs = input.action.kind === "shell" ? Object.entries(w.config.deploy_commands ?? {})
      .filter(([, patterns]) => segments(input.action.kind === "shell" ? input.action.command : "", input.cwd, process.env.HOME ?? "/")
        .some(segment => patterns.some(pattern => new RegExp(pattern).test(segment.head))))
      .map(([env]) => env) : [];
    gate = actions.length > 0 || deployEnvs.length > 0;
    digestKey = "hook-digest:" + w.config.repoDir + "/" + harness + "/" + input.sessionId;
    if (generic === "session_end") {
      w.markEnded(input.sessionId);
      const record = w.cache.get<{ session_id: string; token: string }>("session:" + w.config.repoDir + "/" + harness + "/" + input.sessionId);
      if (record) {
        // Avoid a heartbeat/session-open round trip during the tiny exit budget.
        await new RelayClient(w.config, { ...transport, token: record.token }).request("/sessions/" + record.session_id + "/release", {});
      }
      return output();
    }
    w.recordHook(input.sessionId, harness);
    const rawPaths = input.action.kind === "edit" ? input.action.paths : [];
    paths = rawPaths.map(p => relative(w.config.repoDir, resolve(input.cwd, p)).replaceAll("\\", "/"));
    const touchedKey = "touched:" + w.config.repoDir + "/" + input.sessionId;
    if (paths.length) w.cache.union(touchedKey, paths);
    const cachedSession = w.cache.get<SessionRecord>("session:" + w.config.repoDir + "/" + harness + "/" + input.sessionId);
    const { client, record } = generic === "before_prompt" && cachedSession && Date.parse(cachedSession.expires_at) > Date.now() + 30000
      ? { client: new RelayClient(w.config, { ...transport, token: cachedSession.token, cache: w.cache }), record: cachedSession }
      : await w.session(adapter.sessionTool, input.sessionId, Date.now(), harness);
    sessionId = record.session_id;
    if (generic === "turn_end") { await client.drainOutbox(); await client.heartbeat(record.session_id, "waiting"); return output(); }
    const cursorKey = "hook-cursor:" + record.session_id;
    if (generic === "before_prompt") {
      const cursor = w.cache.get<number>(cursorKey) ?? 0;
      let events = (w.cache.get<Event[]>("events") ?? []).filter(e => e.seq > cursor);
      let offline = false;
      try { events = (await client.events({ after: cursor, limit: 1000 })).result; } catch { offline = true; /* One refresh attempt; retain cached events. */ }
      const snapshot = w.cache.board()?.snapshot as { presence?: { session: string; principal: string }[]; asks?: { ask_id: string; to: string }[] } | undefined;
      const principal = snapshot?.presence?.find(p => p.session === record.session_id)?.principal;
      const branch = gitIdentity(input.cwd).branch, touched = w.cache.get<string[]>(touchedKey) ?? [];
      const relevant = events.filter(e => {
        const body = e.body;
        if (body.type === "message") return body.to.some(to => to === principal || to === "all" || to === "session:" + record.session_id);
        if (body.type === "branch_status") return body.branch === branch;
        if (body.type === "ask") return body.to === principal;
        if (body.type === "decision") return body.source.kind === "ask" && snapshot?.asks?.some(a => a.ask_id === body.source.id && a.to === principal);
        if ("resources" in body) return body.resources.some(r => r === "branch:" + branch || touched.some(p => r === "path:" + p || (r.startsWith("tree:") && p.startsWith(r.slice(5)))));
        return false;
      });
      w.cache.set(cursorKey, events.at(-1)?.seq ?? cursor);
      const items: unknown[] = relevant.map(e => ({ principal: e.actor.principal, ...e.body }));
      if (relevant.some(e => e.body.type === "ask" && e.body.state === "open")) items.unshift(ASK_REMINDER);
      return relevant.length ? output(render(items, { offline, maxTotal: 1499 })) : output();
    }
    if (generic === "session_start") {
      const board = await client.board();
      const inbox = await client.inbox();
      const messages = (inbox.result as { messages?: { body: { parts: unknown; to: unknown } }[] }).messages ?? [];
      const value = hookDigest(board.response.result, gitIdentity(input.cwd).branch, record.session_id, w.cache.get<string[]>(touchedKey) ?? [], messages.map(m => ({ to: m.body.to, parts: m.body.parts })));
      w.cache.set(digestKey, { value, fetched_at: board.fetched_at });
      w.cache.set(cursorKey, board.response.seq);
      return output(render(value, { ...board, maxTotal: 1499 }));
    }
    const boardStarted = performance.now();
    const boardView = await client.board();
    if (boardView.offline) throw new Error("Relay offline");
    const boardResponse = boardView.response;
    const board = boardResponse.result as CoordinationBoard;
    const warnings: unknown[] = [];
    for (const env of deployEnvs) {
      if (!board.leases.some(l => l.holder === record.session_id && l.state === "held" &&
          l.resources.includes("env:" + env) && l.expires_in_s !== undefined &&
          l.expires_in_s - Math.max(2, l.expires_in_s * 0.1) > (performance.now() - boardStarted) / 1000))
        return output(undefined, "deny", render({ reason: "Deploy requires an unexpired held lease; run xt claim env:" + env }));
    }
    const reservations = await reservationConflicts(client, paths.filter(p => !existsSync(resolve(w.config.repoDir, p))), board.coordination.policy?.sequences);
    if (reservations.length) return output(undefined, "deny", render(reservations));
    for (const a of actions) {
      if (!a.dir) throw new Error("Unknown gate source");
      // Gates are checked against this workspace's relay only; another repository fails closed.
      if (execFileSync("git", ["-C", a.dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), stdio: ["ignore", "pipe", "ignore"] }).trim() !== w.config.commonDir)
        return output(undefined, "deny", "crosstalk: this command acts on another repository; run it from a session in that repository");
      if (a.kind === "deploy") {
        const at = a.words.indexOf("--ticket"), arg = at >= 0 ? a.words[at + 1] : undefined;
        if (!arg) throw new Error("Missing deploy ticket");
        let raw = arg;
        if (!arg.startsWith("{")) {
          const file = resolve(a.dir, arg.replace(/^@/, ""));
          if (!statSync(file).isFile() || statSync(file).size > 16384) throw new Error("Invalid ticket file");
          raw = readFileSync(file, "utf8");
        }
        const ticket: unknown = JSON.parse(raw);
        if (!validateTicket(ticket) || ticket.payload.epoch !== boardResponse.epoch || ticket.payload.env !== a.words[0] || ticket.payload.space !== w.config.space || ticket.payload.expires_at <= Date.now() || !await client.verifyRelaySignature(jcs(ticket.payload), ticket.signature)) throw new Error("Invalid deploy ticket");
        const { env, sha, artifact, lease_id, fence, holder } = ticket.payload;
        const result = await client.check({ kind: "deploy", env, sha, artifact, lease_id, fence, holder });
        if (result.result.verdict === "block") return output(undefined, "deny", render(result.result, { maxTotal: 1499 }));
        continue;
      }
      let target = gitIdentity(a.dir).branch;
      let refs = a.refs.length ? a.refs : ["@{upstream}"];
      let prHead: string | undefined;
      if (a.pr !== undefined) {
        const pr = JSON.parse(execFileSync("gh", ["pr", "view", ...(a.pr ? [a.pr] : []), "--json", "headRefName,headRefOid,baseRefName"], { cwd: a.dir, encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), stdio: ["ignore", "pipe", "ignore"] })) as { headRefName: string; headRefOid: string; baseRefName: string };
        if (!pr.headRefName || !pr.headRefOid || !pr.baseRefName) throw new Error("Unknown PR source");
        refs = [pr.headRefName]; target = pr.baseRefName; prHead = pr.headRefOid;
      }
      for (const ref of refs) {
        const git = (...args: string[]) => execFileSync("git", ["-C", a.dir!, ...args], { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), stdio: ["ignore", "pipe", "ignore"] }).trim();
        const head = git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}");
        if (prHead && prHead !== head) throw new Error("Local PR source is stale");
        const symbolic = git("rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref);
        const branches = /^refs\/(heads|remotes)\//.test(symbolic) ? [symbolic.replace(/^refs\/(heads|remotes\/[^/]+)\//, "")] : [];
        const sources: { branch: string; head: string }[] = branches.map(branch => ({ branch, head }));
        if (!branches.length) {
          const current = git("rev-parse", "HEAD");
          const reachable = (a: string, b: string) => {
            signal.throwIfAborted();
            if (Date.now() >= deadline) throw new Error("Gate deadline exceeded");
            return ancestor(refDir, a, b, Math.max(1, deadline - Date.now()));
          };
          const refDir = a.dir;
          const cherryPick = a.words.includes("cherry-pick");
          for (const status of board.coordination.branches) {
            if (!["wip", "draft"].includes(status.state)) continue;
            const candidates = new Set([status.head]);
            for (const prefix of ["refs/heads/", "refs/remotes/origin/"]) {
              try { candidates.add(git("rev-parse", "--verify", "--end-of-options", prefix + status.branch + "^{commit}")); } catch { /* Missing tip. */ }
            }
            for (const candidate of candidates) {
              if (!candidate || reachable(head, current)) continue;
              const reaches = cherryPick ? reachable(head, candidate) : reachable(candidate, head) && !reachable(candidate, current);
              if (reaches) sources.push({ branch: status.branch, head: candidate });
            }
          }
        }
        for (const { branch, head: sourceHead } of sources) {
          if (a.kind === "branch" && branch && !board.coordination.branches.some(b => b.branch === branch && ["wip", "draft"].includes(b.state))) continue;
          signal.throwIfAborted();
          if (Date.now() >= deadline) throw new Error("Gate deadline exceeded");
          const result = await client.check({ kind: "merge", source_branch: branch, source_head: sourceHead, target_branch: target });
          if (a.kind === "branch" && result.result.verdict !== "pass") {
            warnings.push({ branch, ...result.result, verdict: "warn" });
            continue;
          }
          if (result.result.verdict === "block") return output(undefined, "deny", render({ branch, ...result.result }, { maxTotal: 1499 }));
          if (result.result.verdict === "warn") warnings.push(result.result);
        }
      }
    }
    if (gate) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Gate deadline exceeded");
    }
    const conflicts = editConflicts(board, paths, record.session_id);
    if (conflicts.length) {
      const reason = render({ warning: "Path lease conflict; check with your developer", conflicts }, { maxTotal: 1499 });
      const ask = w.config.edit_conflict === "ask" && conflicts.some(l => l.mode !== "shared");
      if (conflicts.some(l => l.mode !== "shared")) return output(reason, ask ? "ask" : undefined, ask ? reason : undefined);
      warnings.push({ warning: "Overlapping shared work", conflicts });
    }
    if (w.config.auto_claim && paths.length) await client.send("lease.claim", { resources: paths.map(p => "path:" + p) });
    return generic === "before_action" ? output(warnings.length ? render(warnings, { maxTotal: 1499 }) : undefined) : output();
  } catch (error) {
    swallowed.error = error;
    if (error instanceof ClientError && ["config_changed", "untrusted"].includes(error.code)) {
      const message = "crosstalk config changed: a human must run `xt trust`";
      if (generic === "turn_end" || generic === "session_end") return output(undefined, undefined, message);
      return output(message, gate ? "deny" : undefined, gate ? message : undefined);
    }
    if (generic === "turn_end" || generic === "session_end" || generic === "before_prompt") return output();
    if (generic === "before_action" && !gate && workspace && paths.length) {
      const cached = workspace.cache.board();
      const conflicts = cached ? editConflicts(cached.snapshot as CoordinationBoard, paths, sessionId) : [];
      if (conflicts.length) {
        const reason = render({ warning: "Cached path lease conflict; check with your developer", conflicts }, { offline: true, fetched_at: cached!.fetched_at, maxTotal: 1499 });
        const ask = workspace.config.edit_conflict === "ask" && conflicts.some(l => l.mode !== "shared");
        return output(reason, ask ? "ask" : undefined, ask ? reason : undefined);
      }
    }
    if (generic === "before_action") {
      const msg = String((error as Error)?.message ?? error);
      const cause = /^Command failed: git /.test(msg) ? "git could not resolve the repository or ref for this command; run the merge or push as its own command inside an existing checkout"
        : (error as Error)?.name === "AbortError" || msg === "Gate deadline exceeded" ? "the check timed out"
        : error instanceof ClientError ? "relay unavailable (" + error.code + ")" : "a local error (" + msg.slice(0, 80) + ")";
      return gate ? output(undefined, "deny", "crosstalk could not confirm the gate: " + cause) : output("crosstalk edit checks unavailable: " + cause + "; proceeding with a warning");
    }
    const cached = workspace?.cache.board();
    const digest = digestKey ? workspace?.cache.get<{ value: unknown; fetched_at: number }>(digestKey) : undefined;
    return output(render(digest?.value ?? (cached ? hookDigest(cached.snapshot, gitIdentity(workspace!.config.repoDir).branch, sessionId ?? "", paths) : undefined) ?? { warning: "crosstalk unavailable; no cached digest" }, { peer: !!(digest || cached), offline: true, fetched_at: digest?.fetched_at ?? cached?.fetched_at ?? Date.now(), maxTotal: 1499 }));
  } finally {
    swallowed.skipped = workspace?.cache.skipped;
    const closing = performance.now();
    workspace?.close();
    swallowed.timings.cache_close_ms = Math.round(performance.now() - closing);
  }
}
// Static import keeps adapter boundaries visible to lint.
import { RelayClient } from "../client/index.js";
