import { canonicalKey } from "../schema/index.js";
import type { Ask, BranchStatus, Decision, Event, Message } from "../schema/index.js";
import type { CommandContext, Handler } from "./commands.js";
import type { Ctx, SqlTx } from "./types.js";
import { emitCommand, readBody } from "./coordination.js";
import { appendEvent, fail, ok, spaceRow } from "./log.js";
import { isAdmin } from "./identity.js";

export interface AskRow { space: string; ask_id: string; asker: string; body: string }
function save(c: CommandContext, body: Ask): void {
  c.tx.run("UPDATE asks SET body=? WHERE space=? AND ask_id=?", JSON.stringify(body), c.actor.space, body.ask_id);
  emitCommand(c, body);
}
export function saveDecision(c: CommandContext, body: Decision): void {
  const event = emitCommand(c, body);
  c.tx.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", c.actor.space, body.decision_id, event.seq, JSON.stringify(body));
}
function notify(c: CommandContext, to: string, context_id: string, texts: string[]): void {
  const body: Message = { type: "message", message_id: c.ctx.uuid(), to: [to], context_id, parts: texts.filter(text => text.length > 0).map(text => ({ kind: "text", text })) };
  const event = emitCommand(c, body);
  c.tx.run("INSERT INTO messages VALUES (?, ?, ?)", c.actor.space, event.seq, JSON.stringify(body));
}
export const askOpen: Handler = c => {
  const { tx, ctx, actor, cmd } = c;
  if (cmd.op !== "ask.open") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  if (!cmd.args.to.startsWith("human:") || !tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, cmd.args.to))
    return fail(tx, actor.space, "not_found", "Addressed human not enrolled");
  if (cmd.args.deadline && Date.parse(cmd.args.deadline) <= ctx.now()) return fail(tx, actor.space, "invalid_request", "Deadline must be in the future");
  if (cmd.args.kind === "approval" && cmd.args.blocks?.length &&
      (!cmd.args.bound_head || (cmd.args.blocks.some(scope => scope.startsWith("deploy:")) && !cmd.args.bound_artifact)))
    return fail(tx, actor.space, "invalid_request", "Blocking approval requires bound_head and deploy scopes require bound_artifact");
  let resources: string[] | undefined;
  try { resources = cmd.args.resources?.map(canonicalKey); } catch { return fail(tx, actor.space, "invalid_resource", "Invalid ask resource"); }
  const body: Ask = { ...cmd.args, ...(resources ? { resources } : {}), type: "ask", ask_id: ctx.uuid(), rev: 1, state: "open" };
  tx.run("INSERT INTO asks VALUES (?, ?, ?, ?)", actor.space, body.ask_id, actor.principal, JSON.stringify(body));
  emitCommand(c, body);
  return ok(tx, actor.space, body);
};
export const askChange: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (cmd.op !== "ask.answer" && cmd.op !== "ask.withdraw" && cmd.op !== "ask.cancel") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const row = tx.get<AskRow>("SELECT * FROM asks WHERE space=? AND ask_id=?", actor.space, cmd.args.ask_id);
  if (!row) return fail(tx, actor.space, "not_found", "Ask not found");
  const ask = JSON.parse(row.body) as Ask;
  const addressed = who.kind === "human" && !who.session && who.principal === ask.to;
  if (cmd.op === "ask.answer" ? !addressed : cmd.op === "ask.withdraw" ? !addressed && !isAdmin(who) : row.asker !== who.principal && !isAdmin(who))
    return fail(tx, actor.space, "not_authorized", "Addressed human key or authorized owner required");
  if (cmd.expect_rev !== ask.rev) return fail(tx, actor.space, "stale_revision", "Expected ask revision required and must match");
  const expired = ask.state === "open" && ask.deadline !== undefined && Date.parse(ask.deadline) <= ctx.now();
  if (cmd.op === "ask.withdraw") {
    if (ask.state === "withdrawn") return fail(tx, actor.space, "stale_revision", "Requirement already withdrawn");
    const updated: Ask = { ...ask, state: "withdrawn", rev: ask.rev + 1 };
    save(c, updated);
    emitCommand(c, { type: "admin", action: "requirement_withdrawn", subject: ask.ask_id, ...(cmd.args.reason ? { reason: cmd.args.reason } : {}) });
    return ok(tx, actor.space, updated);
  }
  const reaffirm = cmd.op === "ask.answer" && cmd.args.reaffirm === true;
  if (reaffirm ? ask.kind !== "approval" || ask.state !== "answered" : ask.state !== "open" || expired)
    return fail(tx, actor.space, "stale_revision", "Ask is no longer answerable at this revision");
  if (cmd.op === "ask.cancel") {
    const updated: Ask = { ...ask, state: "canceled", rev: ask.rev + 1 };
    save(c, updated);
    return ok(tx, actor.space, updated);
  }
  if (ask.kind === "approval" && !["approve", "reject"].includes(cmd.args.choice)) return fail(tx, actor.space, "invalid_request", "Approval choice must be approve or reject");
  if (ask.kind === "question" && ask.options && !ask.options.includes(cmd.args.choice)) return fail(tx, actor.space, "invalid_request", "Choice must be a question option");
  if (!reaffirm && (cmd.args.bound_head !== undefined || cmd.args.bound_artifact !== undefined)) return fail(tx, actor.space, "invalid_request", "Revision changes require reaffirm");
  if (reaffirm && (cmd.args.choice !== "approve" || !cmd.args.bound_head)) return fail(tx, actor.space, "invalid_request", "Reaffirm requires approval and a new head");
  const updated: Ask = { ...ask, rev: ask.rev + 1, state: ask.kind === "approval" && cmd.args.choice === "reject" ? "rejected" : "answered",
    ...(reaffirm ? { bound_head: cmd.args.bound_head!, ...(cmd.args.bound_artifact ? { bound_artifact: cmd.args.bound_artifact } : {}) } : {}) };
  save(c, updated);
  emitCommand(c, { type: "answer", ask_id: ask.ask_id, answer_id: ctx.uuid(), choice: cmd.args.choice, ...(cmd.args.text ? { text: cmd.args.text } : {}) });
  if (ask.kind === "approval") saveDecision(c, { type: "decision", decision_id: ctx.uuid(), source: { kind: "ask", id: ask.ask_id },
    verdict: cmd.args.choice === "approve" ? "approve" : "reject", ...(ask.blocks?.length ? { scope: ask.blocks } : {}),
    bound_head: updated.bound_head ?? null, ...(updated.bound_artifact ? { bound_artifact: updated.bound_artifact } : {}),
    ...(cmd.args.text ? { rationale: cmd.args.text } : {}), decided_by: who.principal });
  notify(c, row.asker, ask.ask_id, [cmd.args.choice || "Answer", ...(cmd.args.text ? [cmd.args.text] : [])]);
  return ok(tx, actor.space, updated);
};
export const overrideRecord: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (who.kind !== "human" || who.session) return fail(tx, actor.space, "not_authorized", "Human key required");
  if (cmd.op !== "override.record") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  if (!cmd.args.bound_head || !cmd.args.scope.every(scope => /^merge:(branch|target):\S+$/.test(scope)))
    return fail(tx, actor.space, "invalid_request", "Override requires merge branch or target scope and a head");
  const body: Decision = { type: "decision", decision_id: ctx.uuid(), source: { kind: "override", id: ctx.uuid() }, verdict: "approve",
    scope: cmd.args.scope, bound_head: cmd.args.bound_head, ...(cmd.args.bound_artifact ? { bound_artifact: cmd.args.bound_artifact } : {}), rationale: cmd.args.reason, decided_by: who.principal };
  saveDecision(c, body);
  for (const scope of cmd.args.scope) {
    if (!scope.startsWith("merge:branch:")) continue;
    const branch = readBody<BranchStatus>(tx, "SELECT body FROM branch_status WHERE space=? AND branch=?", actor.space, scope.slice("merge:branch:".length));
    if (branch) notify(c, branch.owner, body.decision_id, ["Merge override", cmd.args.reason]);
  }
  emitCommand(c, { type: "admin", action: "override_recorded", subject: body.decision_id, reason: cmd.args.reason });
  return ok(tx, actor.space, body);
};
export function expireAsks(tx: SqlTx, ctx: Ctx): Event[] {
  const events: Event[] = [];
  for (const row of tx.all<AskRow>("SELECT * FROM asks WHERE status='open' AND expires<=?", ctx.now())) {
    const ask = JSON.parse(row.body) as Ask;
    if (ask.state !== "open" || !ask.deadline || Date.parse(ask.deadline) > ctx.now()) continue;
    const body: Ask = { ...ask, state: "expired", rev: ask.rev + 1 };
    tx.run("UPDATE asks SET body=? WHERE space=? AND ask_id=?", JSON.stringify(body), row.space, row.ask_id);
    events.push(appendEvent(tx, { ...ctx, epoch: spaceRow(tx, row.space).epoch }, row.space, { principal: "ci:relay", via: "relay", tool: "relay" }, null, body));
  }
  return events;
}
