import { sha256, validateSession } from "../schema/index.js";
import type { Event } from "../schema/index.js";
import { appendEvent, fail, ok, spaceRow } from "./log.js";
import type { Actor, Ctx, Result, SqlTx } from "./types.js";

export type KeyKind = "agent" | "human" | "ci";
export interface Identity {
  principal: string; role: "admin" | "member" | "ci"; kind: KeyKind;
  credential_id: string; session?: string; tool?: Event["actor"]["tool"];
  branch: string | null; head: string | null;
}
export function identity(tx: SqlTx, ctx: Ctx, actor: Actor): Identity | undefined {
  if (spaceRow(tx, actor.space).epoch !== ctx.epoch) return undefined;
  const key = tx.get<Pick<Identity, "principal" | "role" | "kind" | "credential_id">>(
    "SELECT p.principal, p.role, c.kind, c.id AS credential_id FROM credentials c JOIN principals p ON p.space=c.space AND p.principal=c.principal WHERE c.id=? AND c.space=? AND c.principal=? AND p.revoked=0 AND c.revoked=0",
    actor.credential_id, actor.space, actor.principal);
  if (!key) return undefined;
  if (!actor.session) return { ...key, branch: null, head: null };
  const session = tx.get<{ tool: Identity["tool"]; branch: string | null; head: string | null }>(
    "SELECT tool, branch, head FROM sessions WHERE id=? AND space=? AND principal=? AND credential_id=? AND closed=0 AND expires_at>?",
    actor.session, actor.space, actor.principal, actor.credential_id, ctx.now());
  return session ? { ...key, ...session, session: actor.session } : undefined;
}
export function eventActor(who: Identity): Event["actor"] {
  return { principal: who.principal, via: who.kind === "human" ? "human-tty" : who.kind,
    ...(who.session ? { session: who.session } : {}), ...(who.tool ? { tool: who.tool } : {}) };
}
export function isExecutor(tx: SqlTx, ctx: Ctx, space: string, who: Identity, env: string): boolean {
  return who.kind === "ci" && !who.session && !!tx.get(
    "SELECT 1 FROM executors WHERE space=? AND env=? AND principal=? AND epoch=?",
    space, env, who.principal, ctx.epoch);
}
export function isAdmin(who: Identity): boolean { return who.role === "admin" && who.kind === "human" && !who.session; }
/** Trusted relay setup only; cannot replace an existing enrollment. Secrets are supplied by relay CSPRNG. */
export function bootstrapAdmin(tx: SqlTx, ctx: Ctx, space: string, principal: string, secret: string): Result {
  if (!/^human:[a-z0-9][a-z0-9-]{0,38}$/.test(principal) || secret.length < 32)
    return fail(tx, space, "invalid_request", "Invalid principal or secret length");
  if (tx.get("SELECT 1 FROM principals WHERE space=?", space))
    return fail(tx, space, "conflict", "Space already has principals");
  tx.run("INSERT INTO principals(space, principal, role) VALUES (?, ?, 'admin')", space, principal);
  const id = ctx.uuid();
  tx.run("INSERT INTO credentials(id, space, principal, kind, secret_hash) VALUES (?, ?, ?, 'human', ?)", id, space, principal, sha256(secret));
  appendEvent(tx, ctx, space, { principal: "ci:relay", via: "relay", tool: "relay" }, null, { type: "admin", action: "principal_enrolled", subject: principal });
  return ok(tx, space, { credential_id: id });
}
export function issueCredential(tx: SqlTx, ctx: Ctx, actor: Actor, principal: string, kind: KeyKind, secret: string, device?: string): Result {
  const who = identity(tx, ctx, actor);
  if (!who || !isAdmin(who)) return fail(tx, actor.space, "not_authorized", "Human admin key required");
  const target = tx.get<{ role: string }>("SELECT role FROM principals WHERE space=? AND principal=? AND revoked=0", actor.space, principal);
  if (!target) return fail(tx, actor.space, "not_found", "Active principal not found");
  if (!["agent", "human", "ci"].includes(kind) || (target.role === "ci") !== (kind === "ci") || secret.length < 32)
    return fail(tx, actor.space, "invalid_request", "Credential kind must match principal; secret must have at least 32 characters");
  if (tx.get("SELECT 1 FROM credentials WHERE secret_hash=?", sha256(secret)) ||
      tx.get("SELECT 1 FROM sessions WHERE token_hash=?", sha256(secret)))
    return fail(tx, actor.space, "conflict", "Credential already exists");
  if (device !== undefined && (!device.trim() || device.length > 80 || /[\x00-\x1f]/.test(device)))
    return fail(tx, actor.space, "invalid_request", "Invalid device label");
  if (device && tx.get("SELECT 1 FROM credentials WHERE space=? AND principal=? AND COALESCE(device, 'default')=? AND kind=? AND revoked=0", actor.space, principal, device, kind))
    return fail(tx, actor.space, "conflict", "Device credential already exists");
  const id = ctx.uuid();
  tx.run("INSERT INTO credentials(id, space, principal, kind, secret_hash, device) VALUES (?, ?, ?, ?, ?, ?)", id, actor.space, principal, kind, sha256(secret), device ?? null);
  return ok(tx, actor.space, { credential_id: id });
}
export function authenticate(tx: SqlTx, ctx: Ctx, space: string, secret: string): Actor | undefined {
  const hash = sha256(secret);
  const key = tx.get<{ principal: string; credential_id: string }>(
    "SELECT principal, id AS credential_id FROM credentials WHERE space=? AND secret_hash=?", space, hash);
  const session = key ? undefined : tx.get<{ principal: string; credential_id: string; session: string }>(
    "SELECT principal, credential_id, id AS session FROM sessions WHERE space=? AND token_hash=?", space, hash);
  const found = key ?? session;
  if (!found) return undefined;
  const actor = { space, ...found };
  return identity(tx, ctx, actor) ? actor : undefined;
}
export function openSession(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown, token: string): Result {
  const who = identity(tx, ctx, actor);
  if (!who || who.session || who.kind === "human") return fail(tx, actor.space, "not_authorized", "Agent or CI key required");
  if (!validateSession(input) || token.length < 32) return fail(tx, actor.space, "invalid_request", "Invalid session metadata or token length");
  if ((who.kind === "ci") !== (input.tool === "ci")) return fail(tx, actor.space, "not_authorized", "Tool is not allowed for this key kind");
  if (tx.get("SELECT 1 FROM sessions WHERE token_hash=?", sha256(token)) ||
      tx.get("SELECT 1 FROM credentials WHERE secret_hash=?", sha256(token)))
    return fail(tx, actor.space, "invalid_request", "Token must be unique");
  const id = ctx.uuid(), expires = ctx.now() + 86400000;
  tx.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    id, actor.space, who.principal, actor.credential_id, input.tool, input.harness_session_id,
    input.machine, input.worktree, input.branch, input.head, sha256(token), expires);
  tx.run("INSERT INTO presence VALUES (?, 'working', '', ?)", id, ctx.now() + 90000);
  return ok(tx, actor.space, { session_id: id, expires_at: new Date(expires).toISOString(), heartbeat_s: 30, cursor: spaceRow(tx, actor.space).seq });
}
export const presenceDoing = "COALESCE((SELECT note FROM leases WHERE space=s.space AND holder=s.id AND mode='shared' AND state='held' AND expires_at>? ORDER BY created_at DESC, fence DESC LIMIT 1), p.doing)";

export function heartbeat(tx: SqlTx, ctx: Ctx, actor: Actor, state: "working" | "waiting" | "offline", doing = ""): Result {
  const who = identity(tx, ctx, actor);
  if (!who?.session) return fail(tx, actor.space, "not_authorized", "Active session required");
  if (!["working", "waiting", "offline"].includes(state) || typeof doing !== "string" || doing.length > 280)
    return fail(tx, actor.space, "invalid_request", "Invalid presence");
  tx.run("UPDATE sessions SET expires_at=? WHERE id=?", ctx.now() + 86400000, who.session);
  tx.run("UPDATE presence SET state=?, doing=?, expires_at=? WHERE session=?", state, doing, ctx.now() + 90000, who.session);
  return ok(tx, actor.space, { heartbeat_s: 30, leases: tx.all<{ lease_id: string; mode: string; expires_at: number }>(
    "SELECT lease_id, mode, expires_at FROM leases WHERE space=? AND holder=? AND state IN ('pending','held') AND expires_at>?",
    actor.space, who.session, ctx.now()).map(row => ({ lease_id: row.lease_id, mode: row.mode, expires_in_s: (row.expires_at - ctx.now()) / 1000 })) });
}
