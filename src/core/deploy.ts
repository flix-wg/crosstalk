import { jcs, validateDeployInput, validateTicket } from "../schema/index.js";
import type { Deployment, DeployInput, TicketPayload } from "../schema/index.js";
import type { Actor, Ctx, Result, SqlTx } from "./types.js";
import type { Handler } from "./commands.js";
import type { LeaseRow } from "./leases.js";
import { revokeAllLeases } from "./leases.js";
import { identity, isAdmin, isExecutor } from "./identity.js";
import { appendEvent, fail, ok, spaceRow } from "./log.js";
import { emitCommand } from "./coordination.js";
import { evaluateGate, liveState } from "./gates.js";

function signed(ctx: Ctx, payload: object) {
  if (!ctx.signer || ctx.signer.algorithm !== "Ed25519") throw new Error("Ed25519 signer must be injected by relay");
  return { payload, signature: ctx.signer.sign(jcs(payload)) };
}
export function deployTicket(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown): Result {
  const who = identity(tx, ctx, actor);
  if (!who?.session) return fail(tx, actor.space, "not_authorized", "Holder session required");
  if (spaceRow(tx, actor.space).frozen) return fail(tx, actor.space, "frozen", "Space is frozen");
  if (!validateDeployInput(input)) return fail(tx, actor.space, "invalid_request", "Invalid deploy ticket input");
  const lease = tx.get<LeaseRow>("SELECT * FROM leases WHERE space=? AND lease_id=?", actor.space, input.lease_id);
  if (!lease || lease.holder !== who.session || lease.state !== "held" || lease.expires_at <= ctx.now() || lease.fence !== input.fence || lease.resources !== JSON.stringify(["env:" + input.env]))
    return fail(tx, actor.space, "not_authorized", "Session must hold the installed env lease with this fence");
  const payload: TicketPayload = { ...input, kind: "deploy_ticket", space: actor.space, epoch: ctx.epoch, holder: who.session, principal: who.principal, expires_at: ctx.now() + 600_000 };
  return ok(tx, actor.space, signed(ctx, payload));
}
export function deployAuthorize(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown): Result {
  const who = identity(tx, ctx, actor);
  if (!who || who.kind !== "ci" || !!who.session) return fail(tx, actor.space, "not_authorized", "Executor CI credential required");
  if (spaceRow(tx, actor.space).frozen) return fail(tx, actor.space, "frozen", "Space is frozen");
  if (!validateTicket(input)) return fail(tx, actor.space, "invalid_request", "Invalid signed ticket");
  const ticket = input.payload;
  if (!ctx.signer || ctx.signer.algorithm !== "Ed25519") throw new Error("Ed25519 signer must be injected by relay");
  let verified = false;
  try { verified = ctx.signer.verify(jcs(ticket), input.signature); } catch { /* Malformed signatures are untrusted inputs. */ }
  if (!verified || ticket.space !== actor.space || ticket.epoch !== ctx.epoch || ticket.expires_at <= ctx.now())
    return fail(tx, actor.space, "not_authorized", "Ticket signature, space, epoch or deadline is invalid");
  if (!isExecutor(tx, ctx, actor.space, who, ticket.env)) return fail(tx, actor.space, "not_authorized", "Enrolled executor key for this env and epoch required");
  const session = tx.get<{ principal: string }>("SELECT principal FROM sessions WHERE space=? AND id=? AND closed=0 AND expires_at>?", actor.space, ticket.holder, ctx.now());
  if (!session || session.principal !== ticket.principal) return fail(tx, actor.space, "not_authorized", "Ticket holder session is no longer active");
  const gate = evaluateGate(tx, { kind: "deploy", space: actor.space, now: ctx.now(), env: ticket.env, sha: ticket.sha, artifact: ticket.artifact, lease_id: ticket.lease_id, fence: ticket.fence, holder: ticket.holder });
  if (gate.verdict === "block") return fail(tx, actor.space, gate.code ?? "conflict", "Deploy gate blocked", gate);
  const { env, sha, artifact, lease_id, fence, op, holder, principal } = ticket;
  return ok(tx, actor.space, signed(ctx, { kind: "deploy_authorization", space: actor.space, epoch: ctx.epoch, env, sha, artifact, lease_id, fence, op, holder, principal, exec_allowed_until: ctx.now() + 30_000 }));
}
export const deploymentRecord: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (cmd.op !== "deployment.record" && cmd.op !== "env.adopt") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  if (cmd.op === "env.adopt" ? who.kind !== "human" || !!who.session : !isExecutor(tx, c.ctx, actor.space, who, cmd.args.env))
    return fail(tx, actor.space, "not_authorized", "Human adoption or executor CI report required");
  let body: Deployment;
  if (cmd.op === "env.adopt") {
    if (!cmd.args.sha) return fail(tx, actor.space, "invalid_request", "Adoption requires a known SHA");
    if ((liveState(tx, actor.space, cmd.args.env)?.exec_seq ?? 0) > 0) return fail(tx, actor.space, "conflict", "Use executor reconciliation after the first promote");
    body = { type: "deployment", ...cmd.args, op: null, exec_seq: 0, live_after: cmd.args.artifact, outcome: "adopted" };
  } else {
    body = { type: "deployment", ...cmd.args };
    if (body.outcome === "promoted" && body.live_after !== body.artifact) return fail(tx, actor.space, "invalid_request", "Promoted report must confirm its artifact");
    const previous = tx.get<{ body: string }>("SELECT body FROM deployments WHERE space=? AND op=?", actor.space, body.op);
    if (previous) return jcs(JSON.parse(previous.body)) === jcs(body) ? ok(tx, actor.space, JSON.parse(previous.body) as Deployment) :
      fail(tx, actor.space, "idempotency_mismatch", "Deploy op already has another report");
    if (tx.get("SELECT 1 FROM deployments WHERE space=? AND env=? AND exec_seq=?", actor.space, body.env, body.exec_seq))
      return fail(tx, actor.space, "conflict", "Executor sequence already belongs to another op");
  }
  const event = emitCommand(c, body);
  tx.run("INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?)", actor.space, body.env, body.op, body.exec_seq!, event.seq, JSON.stringify(body));
  return ok(tx, actor.space, body);
};
export const executorEnroll: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (!isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required for executor enrollment");
  if (cmd.op !== "executor.enroll") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  if (!tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND role='ci' AND revoked=0", actor.space, cmd.args.executor))
    return fail(tx, actor.space, "not_authorized", "Executor must be an enrolled, active CI principal");
  const current = tx.get<{ value: number }>("SELECT value FROM fence_counters WHERE space=?", actor.space)!.value;
  const next = Math.max(current, cmd.args.max_fence) + 1;
  if (!Number.isSafeInteger(next)) return fail(tx, actor.space, "conflict", "Fence counter exhausted");
  revokeAllLeases(tx, ctx, actor.space, cmd.args.env);
  tx.run("UPDATE fence_counters SET value=? WHERE space=?", next, actor.space);
  tx.run("INSERT INTO executors (space, env, epoch, max_fence, principal) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space, env) DO UPDATE SET epoch=excluded.epoch, max_fence=excluded.max_fence, principal=excluded.principal", actor.space, cmd.args.env, ctx.epoch, cmd.args.max_fence, cmd.args.executor);
  emitCommand(c, { type: "admin", action: "executor_enrolled", subject: cmd.args.env });
  return ok(tx, actor.space, { env: cmd.args.env, epoch: ctx.epoch, fence_floor: next });
};
export const freezeChange: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (!isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required");
  if (cmd.op !== "space.freeze" && cmd.op !== "space.unfreeze") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const frozen = cmd.op === "space.freeze";
  if (!frozen && tx.get("SELECT 1 FROM executors WHERE space=? AND epoch<>?", actor.space, c.ctx.epoch)) return fail(tx, actor.space, "conflict", "Every executor must enroll in the new epoch first");
  tx.run("UPDATE spaces SET frozen=? WHERE space=?", frozen ? 1 : 0, actor.space);
  emitCommand(c, { type: "admin", action: frozen ? "gates_frozen" : "gates_unfrozen", ...(cmd.args.reason ? { reason: cmd.args.reason } : {}) });
  return ok(tx, actor.space, { frozen });
};
/** Trusted restore entry point, within the restore transaction. Caller adopts the returned epoch. */
export function restore(tx: SqlTx, ctx: Ctx, space: string): Result {
  const epoch = ctx.uuid();
  const restored = { ...ctx, epoch };
  tx.run("UPDATE spaces SET epoch=?, frozen=1 WHERE space=?", epoch, space);
  tx.run("UPDATE audit_state SET seq=0 WHERE space=?", space);
  appendEvent(tx, restored, space, { principal: "ci:relay", via: "relay", tool: "relay" }, null, { type: "admin", action: "epoch_started", subject: epoch });
  revokeAllLeases(tx, restored, space);
  appendEvent(tx, restored, space, { principal: "ci:relay", via: "relay", tool: "relay" }, null, { type: "admin", action: "gates_frozen", reason: "Backup restore" });
  return ok(tx, space, { epoch, frozen: true });
}
export type { DeployInput };
