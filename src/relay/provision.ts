import { randomUUID, timingSafeEqual } from "node:crypto";
import * as core from "../core/index.js";
import type { SqlTx, Ctx, Actor, Result } from "../core/index.js";
import { sha256 } from "../schema/index.js";
export function provisioningTables(tx: SqlTx): void {
  tx.run("CREATE TABLE IF NOT EXISTS invitation_options(space TEXT NOT NULL, hash TEXT NOT NULL, device TEXT, generation INTEGER NOT NULL, PRIMARY KEY(space,hash))");
  tx.run("CREATE TABLE IF NOT EXISTS invitations(space TEXT NOT NULL, hash TEXT NOT NULL, principal TEXT NOT NULL, issuer TEXT NOT NULL, credential TEXT NOT NULL, expires INTEGER NOT NULL, redeemed TEXT, PRIMARY KEY(space,hash))");
}
export function operatorMatches(expected: string | undefined, actual: string): boolean {
  return !!expected && expected.length >= 32 && timingSafeEqual(Buffer.from(sha256(expected)), Buffer.from(sha256(actual)));
}
export function initializeSpace(tx: SqlTx, input: Record<string, unknown>): Result {
  const { space, principal, humanKey, agentKey } = input;
  const existing = typeof space === "string" ? tx.get<{ epoch: string }>("SELECT epoch FROM spaces WHERE space=?", space) : undefined;
  if (typeof space !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(space) || typeof principal !== "string" || !/^human:[a-z0-9][a-z0-9-]{0,38}$/.test(principal) || typeof humanKey !== "string" || typeof agentKey !== "string" || humanKey.length < 32 || agentKey.length < 32 || humanKey === agentKey) {
    if (existing && typeof space === "string") return core.fail(tx, space, "conflict", "Conflicting bootstrap");
    throw new Error("Invalid bootstrap");
  }
  const ctx: Ctx = { now: Date.now, uuid: randomUUID, epoch: existing?.epoch ?? randomUUID() };
  if (existing) {
    const human = core.authenticate(tx, ctx, space, humanKey), agent = core.authenticate(tx, ctx, space, agentKey);
    const humanIdentity = human && core.identity(tx, ctx, human), agentIdentity = agent && core.identity(tx, ctx, agent);
    if (human?.principal !== principal || agent?.principal !== principal || humanIdentity?.role !== "admin" ||
      humanIdentity.kind !== "human" || humanIdentity.session || agentIdentity?.kind !== "agent" || agentIdentity.session)
      return core.fail(tx, space, "conflict", "Conflicting bootstrap");
    return core.ok(tx, space, { initialized: true });
  }
  core.createSpace(tx, ctx, space);
  const result = core.bootstrapAdmin(tx, ctx, space, principal, humanKey);
  if ("error" in result) throw new Error("Bootstrap failed");
  const actor = core.authenticate(tx, ctx, space, humanKey)!;
  const issued = core.issueCredential(tx, ctx, actor, principal, "agent", agentKey);
  if ("error" in issued) throw new Error("Bootstrap failed");
  return core.ok(tx, space, { initialized: true });
}
export function createInvitation(tx: SqlTx, ctx: Ctx, actor: Actor, input: Record<string, unknown>): Result {
  const who = core.identity(tx, ctx, actor);
  if (!who || who.kind !== "human" || who.role !== "admin" || who.session) return core.fail(tx, actor.space, "not_authorized", "Admin required");
  if (typeof input.code_hash !== "string" || !/^[0-9a-f]{64}$/.test(input.code_hash)) return core.fail(tx, actor.space, "invalid_request", "Invalid invite hash");
  if (input.device !== undefined && (typeof input.device !== "string" || !input.device.trim() || input.device.length > 80 || /[\x00-\x1f]/.test(input.device))) return core.fail(tx, actor.space, "invalid_request", "Invalid device label");
  const existing = tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, String(input.principal));
  const result = input.device && existing ? core.ok(tx, actor.space, { principal: input.principal }) : core.execute(tx, ctx, actor, { request_id: input.request_id, op: "principal.invite", args: { principal: input.principal, role: input.role } });
  if ("error" in result) return result;
  tx.run("INSERT OR IGNORE INTO invitations VALUES (?,?,?,?,?,?,NULL)", actor.space, input.code_hash, String(input.principal), actor.principal, actor.credential_id, ctx.now() + 86400000);
  const generation = tx.get<{ generation: number }>("SELECT generation FROM principals WHERE space=? AND principal=?", actor.space, String(input.principal))!.generation;
  tx.run("INSERT OR IGNORE INTO invitation_options VALUES (?,?,?,?)", actor.space, input.code_hash, typeof input.device === "string" ? input.device : null, generation);
  return result;
}
export function redeemInvitation(tx: SqlTx, ctx: Ctx, space: string, code: string, input: Record<string, unknown>): Result {
  const row = tx.get<{ principal: string; issuer: string; credential: string; expires: number; redeemed: string | null }>("SELECT * FROM invitations WHERE space=? AND hash=?", space, sha256(code).replace(/^sha256:/, ""));
  const { agentKey, humanKey } = input;
  if (!row || row.expires <= ctx.now() || typeof agentKey !== "string" || typeof humanKey !== "string" || agentKey.length < 32 || humanKey.length < 32 || agentKey === humanKey) return core.fail(tx, space, "not_authorized", "Invalid invite");
  const actor = { space, principal: row.issuer, credential_id: row.credential };
  const issuer = core.identity(tx, ctx, actor);
  if (!issuer || issuer.kind !== "human" || issuer.role !== "admin" || !tx.get("SELECT 1 FROM principals WHERE space=? AND principal=? AND revoked=0", space, row.principal)) return core.fail(tx, space, "not_authorized", "Invite revoked");
  const target = tx.get<{ role: string; generation: number }>("SELECT role, generation FROM principals WHERE space=? AND principal=?", space, row.principal)!;
  const options = tx.get<{ device: string | null; generation: number }>("SELECT device, generation FROM invitation_options WHERE space=? AND hash=?", space, sha256(code).slice(7));
  if ((options?.generation ?? 0) !== target.generation) return core.fail(tx, space, "not_authorized", "Invite revoked");
  const fingerprint = sha256(agentKey + ":" + humanKey);
  if (row.redeemed) return row.redeemed === fingerprint ? core.ok(tx, space, { enrolled: true }) : core.fail(tx, space, "not_authorized", "Invite already redeemed");
  const credentials = target.role === "ci" ? [["ci", agentKey] as const] : [["agent", agentKey] as const, ["human", humanKey] as const];
  const device = options?.device ?? undefined;
  for (const [kind, key] of credentials) {
    const result = core.issueCredential(tx, ctx, actor, row.principal, kind, key, device);
    if ("error" in result) throw new Error("Enrollment refused"); // Roll back both credentials.
  }
  tx.run("UPDATE invitations SET redeemed=? WHERE space=? AND hash=?", fingerprint, space, sha256(code).replace(/^sha256:/, ""));
  return core.ok(tx, space, { enrolled: true });
}
