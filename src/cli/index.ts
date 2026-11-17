import { harnessAdapter, branchArguments } from "../client/index.js";
import { readFileSync } from "node:fs";
import { runHook } from "../hooks/index.js";
import { installHarness } from "../hooks/install.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ClientError, Workspace, RelayClient, loadConfig, loadHumanKey, credentialScope, gitIdentity, render, relevantBoard } from "../client/index.js";
import { validateCommand } from "../schema/index.js";
import type { CommandArgs } from "../schema/index.js";
import { usage } from "./help.js";
import { mergeGate } from "./gate.js";
import { Args } from "./args.js";
import { requireHumanTTY, readTerminal } from "./tty.js";
import { initialize, enroll, invite } from "../client/index.js";
export { requireHumanTTY, readTerminal } from "./tty.js";

export interface CLIOptions { cwd?: string; out?: (text: string) => void; err?: (text: string) => void }
export interface CommandContext { args: Args; cwd: string; out(text: string): void; err(text: string): void; invocation: string[] }
export type CommandHandler = (context: CommandContext) => Promise<number>;
export const commands = new Map<string, CommandHandler>();
export function registerCommand(name: string, handler: CommandHandler): void { commands.set(name, handler); }
registerCommand("gate", mergeGate);
const child = (bin: string, args: string[], cwd: string): Promise<number> => new Promise(resolve => {
  const proc = spawn(bin, bin === process.execPath ? ["--import", fileURLToPath(new URL("./warnings.js", import.meta.url)), ...args] : args, { cwd, stdio: "inherit" });
  const interrupt = () => { proc.kill("SIGINT"); }, terminate = () => { proc.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const finish = (code: number) => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); resolve(code); };
  proc.once("error", () => finish(1));
  proc.once("exit", code => finish(code ?? 1));
});
for (const name of ["executor", "audit"])
  registerCommand(name, c => child(process.execPath, [fileURLToPath(new URL("../" + (name === "audit" ? "exporter" : "executor") + "/main.js", import.meta.url)), ...c.invocation], c.cwd));

for (const name of ["install", "hook"]) registerCommand(name, async c => {
  const target = c.args.pos();
  const module = target === "git" || target === "git-hooks" ? "githooks" : "hooks";
  if (module === "hooks") harnessAdapter(target);
  const local = c.args.take("local");
  const rest = c.args.positional.splice(0); c.args.done();
  if (module === "hooks") {
    if (name === "install") { c.out(installHarness(c.cwd, target, !!local)); return 0; }
    const result = await runHook(target, rest[0], readFileSync(0, "utf8"));
    c.out(result.stdout); return result.exitCode;
  }
  if (target === "git" && rest[0] === "seed") requireHumanTTY("Seed protected-branch reachability");
  return child(process.execPath, [fileURLToPath(new URL("../" + module + "/main.js", import.meta.url)), name, target, ...rest, ...(local ? ["--local"] : [])], c.cwd);
});

function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)); }
async function normal(name: string, c: CommandContext): Promise<number> {
  const a = c.args, json = a.take("json") !== undefined;
  const emit = (value: unknown) => c.out(json ? JSON.stringify(value) : render(value, { hooks: false, peer: ["board", "inbox", "asks", "check"].includes(name) }));
  if (name === "trust") {
    a.done();
    const config = loadConfig(c.cwd);
    requireHumanTTY("Trust configuration: " + render({ space: config.space, relay: config.relay, relay_key: config.relay_key }, { peer: false, preserveUrls: true, hooks: false }));
    loadHumanKey(credentialScope(config), { warn: c.err });
    config.trust(); emit({ trusted: true }); return 0;
  }
  if (name === "init") {
    const relay = a.need("relay"), principal = a.need("principal"), relayKey = a.need("relay-key"); a.done();
    requireHumanTTY("Create a space for " + render({ principal, relay, relayKey }, { peer: false, preserveUrls: true, hooks: false }));
    await initialize(c.cwd, { relay, principal, relayKey, operatorKey: readTerminal("Relay operator key: ", true) });
    emit({ initialized: true }); return 0;
  }
  if (name === "enroll") {
    a.done(); const config = loadConfig(c.cwd); requireHumanTTY("Enroll with " + render({ relay: config.relay, space: config.space, relay_key: config.relay_key }, { peer: false, preserveUrls: true, hooks: false }));
    await enroll(c.cwd, readTerminal("Invite code: ", true)); emit({ enrolled: true }); return 0;
  }
  const sub = ["admin", "ask", "env"].includes(name) ? a.positional[0] : undefined;
  // Releasing another session's lease needs the human key: the CLI session uses the same agent key as the agents.
  const human = ["answer", "override", "admin", "env"].includes(name) || (name === "ask" && sub === "withdraw" && !!a.take("human")) || (name === "release" && !!a.take("human"));
  let workspace: Workspace | undefined;
  try {
    let client: RelayClient, sessionId: string | undefined;
    if (human) {
      requireHumanTTY("Authorize xt " + name + " " + render(c.invocation, { hooks: false, peer: false }));
      const config = loadConfig(c.cwd); config.assertTrusted();
      client = new RelayClient(config, { token: loadHumanKey(credentialScope(config), { warn: c.err }) });
    } else { workspace = new Workspace(c.cwd); const session = await workspace.cliSession(); client = session.client; sessionId = session.record.session_id; }
    const git = gitIdentity(c.cwd);
    let op: keyof CommandArgs | undefined, args: Record<string, unknown> = {}, rev = a.number("expect-rev");
    switch (name) {
      case "board": { a.done(); const board = await client.board(); c.out(json ? JSON.stringify(board) : render(relevantBoard(board.response.result, git.branch, sessionId), { hooks: false, ...board })); return board.offline ? 4 : 0; }
      case "inbox": { const ack = a.number("ack"); a.done(); emit(ack === undefined ? await client.inbox() : await client.send("inbox.ack", { cursor: ack })); return 0; }
      case "asks": a.done(); emit(await client.asks()); return 0;
      case "announce": {
        const close = a.take("close");
        if (close) { op = "lease.release"; args = { lease_id: close }; }
        else { op = "lease.claim"; args = { mode: "shared", note: a.pos(), resources: a.all("res"), ttl_s: a.number("ttl") }; }
        break;
      }
      case "claim": op = "lease.claim"; args = { mode: a.take("shared") ? "shared" : undefined, resources: a.positional.splice(0), ttl_s: a.number("ttl"), note: a.take("note") }; { const id = a.take("expect-lease"); if (id) args.expect = { lease_id: id, rev: a.number("lease-rev") }; } break;
      case "release": op = "lease.release"; args = { lease_id: a.pos() }; break;
      case "reserve": op = "reserve"; args = { sequence: a.pos(), floor: a.number("floor"), abandon: a.number("abandon"), note: a.take("note") }; break;
      case "send": op = "message.send"; args = { to: [a.pos()], context_id: a.take("context") ?? randomUUID(), parts: [{ kind: "text", text: a.pos() }] }; break;
      case "ask":
        if (sub === "cancel") throw new ClientError("usage", "Use xt ask withdraw <id> instead");
        if (sub === "withdraw") { a.pos(); op = "ask.withdraw"; args = { ask_id: a.pos(), reason: a.take("reason") }; }
        else { op = "ask.open"; args = { to: a.pos(), question: a.pos(), kind: a.take("approval") ? "approval" : "question", options: a.all("option"), resources: a.all("res"), blocks: a.all("blocks"), bound_head: a.take("head") ?? git.head, bound_artifact: a.take("artifact"), deadline: a.take("deadline") }; for (const k of ["options", "resources", "blocks"]) if (!(args[k] as string[]).length) delete args[k]; }
        break;
      case "answer": op = "ask.answer"; args = { ask_id: a.pos(), choice: a.pos(), text: a.take("text"), bound_head: a.take("head"), bound_artifact: a.take("artifact") }; break;
      case "branch": op = "branch.set"; args = { state: a.pos(), branch: a.take("branch") ?? git.branch, head: a.take("head") ?? git.head, note: a.take("note"), pending: a.all("pending"), owner: a.take("owner") }; branchArguments(c.cwd, args); break;
      case "override": {
        if (a.pos() !== "merge") throw new ClientError("usage", "Only merge overrides are supported");
        const branch = a.take("branch"), target = a.take("target");
        if (!!branch === !!target) throw new ClientError("usage", "Specify exactly one of --branch or --target");
        op = "override.record"; args = { scope: [branch ? "merge:branch:" + branch : "merge:target:" + target], bound_head: a.need("head"), reason: a.need("reason") }; break;
      }
      case "env": if (a.pos() !== "adopt") { c.err("not built yet; use xt executor reconcile on the target"); return 2; } op = "env.adopt"; args = { env: a.pos(), sha: a.need("sha"), artifact: a.need("artifact") }; break;
      case "check": {
        const kind = a.pos();
        const input = kind === "merge" ? { kind, source_branch: a.take("branch") ?? git.branch, source_head: a.take("head") ?? git.head, target_branch: a.need("target"), unknown_source: a.take("unknown-source") ? true : undefined } : { kind, env: a.pos(), sha: a.need("sha"), artifact: a.need("artifact"), lease_id: a.need("lease"), fence: a.number("fence"), holder: a.need("holder") };
        a.done(); const response = await client.check(compact(input)); emit(response); return response.result.verdict === "block" ? 3 : 0;
      }
      case "admin": {
        switch (a.pos()) {
          case "unfreeze": op = "space.unfreeze"; args = { reason: a.take("reason") }; break;
          case "revoke-lease": op = "lease.revoke"; args = { lease_id: a.pos(), reason: a.need("reason") }; break;
          case "revoke": op = "principal.revoke"; args = { principal: a.pos(), reason: a.take("reason"), device: a.take("device") }; break;
          case "invite": { const principal = a.pos(), role = a.take("role") ?? "member", file = a.need("out"), device = a.take("device"); a.done(); await invite(client, principal, role, file, device); emit({ saved: file }); return 0; }
          case "policy": {
            if (a.pos() !== "set") throw new ClientError("usage", "Use admin policy set");
            op = "policy.set";
            const protectedBranches = [...a.all("protected-branch"), ...a.all("protected-branches").flatMap(s => s.split(","))]; if (protectedBranches.length) args.protected_branches = protectedBranches;
            const merge = compact({ unknown: a.take("gates.merge.unknown") ?? a.take("unknown"), unknown_source: a.take("gates.merge.unknown_source") ?? a.take("unknown-source-policy"), stale_ready: a.take("gates.merge.stale_ready") ?? a.take("stale-ready") });
            if (Object.keys(merge).length) args.gates = { merge };
            const env = a.take("env"); if (env) args.envs = { [env]: { require_on: a.need("require-on") } };
            const raw = a.take("args"); if (raw) args = JSON.parse(raw) as Record<string, unknown>;
            break;
          }
          default: throw new ClientError("usage", "Unknown admin command");
        }
        break;
      }
      default: throw new ClientError("usage", "Unknown command");
    }
    a.done();
    if (["ask.answer", "ask.withdraw"].includes(op!) && rev === undefined) {
      const ask = (await client.asks()).result.find(ask => ask.ask_id === args.ask_id);
      if (!ask) throw new ClientError("not_found", "Ask not found");
      rev = ask.rev;
    }
    const command: unknown = { request_id: randomUUID(), op, args: compact(args), ...(rev === undefined ? {} : { expect_rev: rev }) };
    if (!validateCommand(command)) throw new ClientError("usage", "Invalid command arguments: " + (validateCommand.errors?.slice(0, 3).map(e => e.instancePath + " " + e.message).join("; ") ?? "check values"));
    emit(await (command.op === "reserve" ? client.send("reserve", command.args) : client.command(command))); return 0;
  } finally { workspace?.close(); }
}
for (const name of ["init", "enroll", "trust", "board", "announce", "claim", "release", "reserve", "send", "inbox", "ask", "asks", "answer", "branch", "check", "override", "env", "admin"])
  registerCommand(name, c => normal(name, c));
export async function runCLI(argv: string[], options: CLIOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd(), out = options.out ?? console.log, err = options.err ?? console.error;
  const [name, ...rest] = argv;
  if (name === "relay" && !rest.includes("--help")) return child(process.execPath, [fileURLToPath(new URL("../relay/main.js", import.meta.url)), ...rest], cwd);
  if (name === "mcp" && !rest.includes("--help")) return child(process.execPath, [fileURLToPath(new URL("../bridge/main.js", import.meta.url)), ...rest], cwd);
  try {
    if (!name || name === "--help" || name === "help") { out(usage()); return 0; }
    if (rest.includes("--help")) { out(usage(name)); return 0; }
    const handler = commands.get(name); if (!handler) throw new ClientError("usage", "Unknown xt command");
    return await handler({ args: new Args(rest), cwd, out, err, invocation: rest });
  } catch (e) {
    const error = e instanceof ClientError ? e : new ClientError("error", "Command failed; check configuration and arguments");
    if (rest.includes("--json")) out(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }));
    else err(render({ code: error.code, message: error.message }, { hooks: false, peer: false }) + (error.details ? "\n" + render(error.details, { hooks: false }) : ""));
    if (name === "gate") return rest[0] !== "advance" && error.code === "usage" ? 2 : 1;
    return ["unknown", "queued"].includes(error.code) ? 4 : ["conflict", "stale_revision", "blocked", "frozen"].includes(error.code) ? 3 : 1;
  }
}
