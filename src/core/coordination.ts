import type { BranchStatus, CommandArgs, Event, Payload } from "../schema/index.js";
import type { CommandContext, Handler } from "./commands.js";
import type { SqlTx } from "./types.js";
import { appendEvent, fail, ok, spaceRow } from "./log.js";
import { eventActor, isAdmin } from "./identity.js";

export function emitCommand(c: CommandContext, body: Payload): Event {
  return appendEvent(c.tx, c.ctx, c.actor.space, eventActor(c.who), c.cmd.request_id, body);
}
export function readBody<T>(tx: SqlTx, sql: string, ...args: string[]): T | undefined {
  const row = tx.get<{ body: string }>(sql, ...args);
  return row ? JSON.parse(row.body) as T : undefined;
}
export const reserve: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (cmd.op !== "reserve") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const { sequence, abandon, note } = cmd.args;
  if (abandon !== undefined) {
    const row = tx.get<{ holder: string; principal: string; abandoned: number }>("SELECT r.holder, s.principal, r.abandoned FROM reservations r JOIN sessions s ON s.id=r.holder WHERE r.space=? AND r.sequence=? AND r.value=?", actor.space, sequence, abandon);
    if (!row) return fail(tx, actor.space, "not_found", "Reservation not found");
    if (row.principal !== who.principal && !isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Reservation holder required");
    if (row.abandoned) return ok(tx, actor.space, { value: abandon, abandoned: true });
    tx.run("UPDATE reservations SET abandoned=1 WHERE space=? AND sequence=? AND value=?", actor.space, sequence, abandon);
    emitCommand(c, { type: "reservation", sequence, value: abandon, holder: row.holder, note: ("abandoned" + (note ? ": " + note : "")).slice(0, 280) });
    return ok(tx, actor.space, { value: abandon, abandoned: true });
  }
  if (!who.session) return fail(tx, actor.space, "not_authorized", "Reservation holder session required");
  const last = tx.get<{ value: number | null }>("SELECT MAX(value) AS value FROM reservations WHERE space=? AND sequence=?", actor.space, sequence)?.value ?? 0;
  const value = Math.max(cmd.args.floor ?? 0, last + 1);
  if (!Number.isSafeInteger(value)) return fail(tx, actor.space, "conflict", "Sequence exhausted");
  tx.run("INSERT INTO reservations(space, sequence, value, holder) VALUES (?, ?, ?, ?)", actor.space, sequence, value, who.session);
  emitCommand(c, { type: "reservation", sequence, value, holder: who.session, ...(note === undefined ? {} : { note }) });
  return ok(tx, actor.space, { value });
};
export const branchSet: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (cmd.op !== "branch.set") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const old = readBody<BranchStatus>(tx, "SELECT body FROM branch_status WHERE space=? AND branch=?", actor.space, cmd.args.branch);
  const policy = readBody<Policy>(tx, "SELECT body FROM policies WHERE space=?", actor.space);
  const targets = (policy?.protected_branches ?? []).map(refName);
  const reusable = old && (!tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, old.owner) ||
    (old.state === "ready" && !targets.includes(refName(old.branch)) &&
      targets.some(target => tx.get("SELECT 1 FROM reachability WHERE space=? AND ref=? AND sha=?", actor.space, target, old.head))));
  if (old && old.owner !== who.principal && !isAdmin(who) && !reusable)
    return fail(tx, actor.space, "not_authorized", "Branch belongs to " + old.owner + "; ask them or an admin to transfer ownership");
  if (cmd.expect_rev !== undefined && cmd.expect_rev !== old?.rev) return fail(tx, actor.space, "stale_revision", "Branch revision changed");
  if (cmd.args.owner && (!old && cmd.args.owner !== who.principal)) return fail(tx, actor.space, "not_authorized", "First setter owns the branch");
  const reclaim = reusable && old.owner !== who.principal && !isAdmin(who);
  if (reclaim && cmd.args.owner && cmd.args.owner !== who.principal)
    return fail(tx, actor.space, "not_authorized", "Reclaim must name the caller as owner");
  const owner = cmd.args.owner ?? (reclaim ? who.principal : old?.owner) ?? who.principal;
  if (!tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, owner)) return fail(tx, actor.space, "not_found", "Active owner not found");
  const body: BranchStatus = { ...cmd.args, type: "branch_status", owner, rev: (old?.rev ?? 0) + 1 };
  tx.run("INSERT INTO branch_status VALUES (?, ?, ?) ON CONFLICT(space, branch) DO UPDATE SET body=excluded.body", actor.space, body.branch, JSON.stringify(body));
  emitCommand(c, body);
  if (old && reusable && old.owner !== owner) {
    const message = { type: "message" as const, message_id: c.ctx.uuid(), to: [old.owner], context_id: c.ctx.uuid(),
      parts: [{ kind: "text" as const, text: owner + " now owns branch " + body.branch }] };
    const event = emitCommand(c, message);
    tx.run("INSERT INTO messages VALUES (?, ?, ?)", actor.space, event.seq, JSON.stringify(message));
  }
  return ok(tx, actor.space, body);
};
export const messaging: Handler = c => {
  const { tx, ctx, actor, cmd } = c;
  if (cmd.op === "inbox.ack") {
    if (cmd.args.cursor > spaceRow(tx, actor.space).seq) return fail(tx, actor.space, "invalid_request", "Cursor exceeds event log");
    tx.run("INSERT INTO inbox_cursors VALUES (?, ?, ?) ON CONFLICT(space, principal) DO UPDATE SET cursor=MAX(cursor, excluded.cursor)", actor.space, c.who.tool === "cli" ? actor.principal : actor.session ?? actor.principal, cmd.args.cursor);
    return ok(tx, actor.space, tx.get("SELECT cursor FROM inbox_cursors WHERE space=? AND principal=?", actor.space, c.who.tool === "cli" ? actor.principal : actor.session ?? actor.principal));
  }
  if (cmd.op !== "message.send") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const body = { type: "message" as const, message_id: ctx.uuid(), ...cmd.args };
  const event = emitCommand(c, body);
  tx.run("INSERT INTO messages VALUES (?, ?, ?)", actor.space, event.seq, JSON.stringify(body));
  return ok(tx, actor.space, body);
};
export type Policy = CommandArgs["policy.set"];
export const policySet: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (!isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required");
  if (cmd.op !== "policy.set") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const old = readBody<Policy>(tx, "SELECT body FROM policies WHERE space=?", actor.space) ?? {};
  const body: Policy = { ...old, ...cmd.args, gates: { merge: { ...old.gates?.merge, ...cmd.args.gates?.merge } }, envs: { ...old.envs, ...cmd.args.envs } };
  tx.run("INSERT INTO policies VALUES (?, ?) ON CONFLICT(space) DO UPDATE SET body=excluded.body", actor.space, JSON.stringify(body));
  emitCommand(c, { type: "admin", action: "policy_set", subject: JSON.stringify(body) });
  return ok(tx, actor.space, body);
};
export const refName = (ref: string): string => ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
export const refAdvance: Handler = c => {
  const { tx, actor, who, cmd } = c;
  if (cmd.op !== "ref.advance" && cmd.op !== "ref.seed") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  if (cmd.op === "ref.seed" ? !isAdmin(who) : who.principal !== "ci:remote" || who.kind !== "ci" || !!who.session)
    return fail(tx, actor.space, "not_authorized", "Remote CI key or admin seed required");
  for (const sha of cmd.args.commits) tx.run("INSERT OR IGNORE INTO reachability VALUES (?, ?, ?)", actor.space, refName(cmd.args.ref), sha);
  if (cmd.op === "ref.seed") emitCommand(c, { type: "admin", action: "ref_seeded", subject: cmd.args.ref });
  return ok(tx, actor.space, { ref: cmd.args.ref });
};
