import { deploymentRecord, executorEnroll, freezeChange } from "./deploy.js";
import { askOpen, askChange, overrideRecord } from "./asks.js";
import { reserve, intent, branchSet, messaging, policySet, refAdvance } from "./coordination.js";
import { claim, releaseOrRevoke, revokePrincipalLeases, releaseSession } from "./leases.js";
import { validateCommand, commandArgsSchemas, jcs } from "../schema/index.js";
import type { Command } from "../schema/index.js";
import type { Actor, Ctx, Result, SqlTx } from "./types.js";
import { appendEvent, fail, ok, withReceipt, spaceRow } from "./log.js";
import { eventActor, identity, isAdmin } from "./identity.js";
import type { Identity } from "./identity.js";

export interface CommandContext { tx: SqlTx; ctx: Ctx; actor: Actor; who: Identity; cmd: Command }
export type Handler = (c: CommandContext) => Result;
const invite: Handler = ({ tx, ctx, actor, who, cmd }) => {
  if (!isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required");
  if (cmd.op !== "principal.invite") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const { principal, role } = cmd.args;
  if (principal.startsWith("ci:") !== (role === "ci"))
    return fail(tx, actor.space, "invalid_request", "Role must match principal kind");
  if (tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, principal))
    return fail(tx, actor.space, "conflict", "Principal already enrolled");
  tx.run("INSERT INTO principals(space, principal, role) VALUES (?, ?, ?) ON CONFLICT(space, principal) DO UPDATE SET role=excluded.role, revoked=0", actor.space, principal, role);
  appendEvent(tx, ctx, actor.space, eventActor(who), cmd.request_id, { type: "admin", action: "principal_enrolled", subject: principal });
  return ok(tx, actor.space, { principal, role });
};
const revoke: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (!isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required");
  if (cmd.op !== "principal.revoke") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const { principal, reason } = cmd.args;
  if (!tx.get("SELECT 1 FROM principals WHERE space=? AND principal=?", actor.space, principal))
    return fail(tx, actor.space, "not_found", "Principal not found");
  if (cmd.args.device !== undefined) {
    const ids = tx.all<{ id: string }>("SELECT id FROM credentials WHERE space=? AND principal=? AND COALESCE(device, 'default')=? AND revoked=0", actor.space, principal, cmd.args.device);
    if (!ids.length) return fail(tx, actor.space, "not_found", "Active device not found");
    for (const { id } of ids) {
      revokePrincipalLeases(c, principal, id);
      tx.run("UPDATE credentials SET revoked=1 WHERE id=?", id);
      tx.run("UPDATE sessions SET closed=1 WHERE credential_id=?", id);
    }
    appendEvent(tx, ctx, actor.space, eventActor(who), cmd.request_id, { type: "admin", action: "principal_revoked", subject: principal + "/" + cmd.args.device });
    return ok(tx, actor.space, { principal, device: cmd.args.device });
  }
  revokePrincipalLeases(c, principal);
  tx.run("UPDATE credentials SET revoked=1 WHERE space=? AND principal=?", actor.space, principal);
  tx.run("UPDATE principals SET revoked=1, generation=generation+1 WHERE space=? AND principal=?", actor.space, principal);
  tx.run("UPDATE sessions SET closed=1 WHERE space=? AND principal=?", actor.space, principal);
  tx.run("DELETE FROM presence WHERE session IN (SELECT id FROM sessions WHERE space=? AND principal=?)", actor.space, principal);
  appendEvent(tx, ctx, actor.space, eventActor(who), cmd.request_id, { type: "admin", action: "principal_revoked", subject: principal, ...(reason ? { reason } : {}) });
  return ok(tx, actor.space, { principal });
};
const handlers: Partial<Record<Command["op"], Handler>> = { "session.release": releaseSession, "principal.invite": invite, "principal.revoke": revoke,
  "deployment.record": deploymentRecord, "env.adopt": deploymentRecord, "executor.enroll": executorEnroll, "space.freeze": freezeChange, "space.unfreeze": freezeChange,
  "ask.open": askOpen, "ask.answer": askChange, "ask.withdraw": askChange, "override.record": overrideRecord,
  reserve, "intent.post": intent, "intent.close": intent, "branch.set": branchSet, "message.send": messaging, "inbox.ack": messaging, "policy.set": policySet, "ref.advance": refAdvance, "ref.seed": refAdvance,
  "lease.claim": claim, "lease.release": releaseOrRevoke, "lease.revoke": releaseOrRevoke };
export function execute(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown): Result {
  const now = ctx.now();
  const commandCtx: Ctx = { ...ctx, now: () => now, uuid: () => ctx.uuid(), epoch: ctx.epoch };
  const who = identity(tx, commandCtx, actor);
  if (!who || (!who.session && who.kind !== "human" && who.kind !== "ci")) return fail(tx, actor.space, "not_authorized", "Session, human key or CI key required");
  if (input && typeof input === "object" && "op" in input && typeof input.op === "string" && !Object.hasOwn(commandArgsSchemas, input.op))
    return fail(tx, actor.space, "unsupported_op", "Unknown operation");
  if (!validateCommand(input)) return fail(tx, actor.space, "invalid_request", "Invalid command");
  try { jcs(input); } catch { return fail(tx, actor.space, "invalid_request", "Command must be canonical JSON data"); }
  if (input.op === "reserve" && spaceRow(tx, actor.space).frozen) return fail(tx, actor.space, "frozen", "Space is frozen");
  const handler = handlers[input.op];
  if (!handler) return fail(tx, actor.space, "unsupported_op", "Operation is not implemented");
  return withReceipt(tx, actor.space, actor.session ? actor.principal + "/" + actor.session : actor.principal, input.request_id, input,
    () => handler({ tx, ctx: commandCtx, actor, who, cmd: input }));
}
