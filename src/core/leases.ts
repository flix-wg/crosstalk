import { canonicalKey, foldKey, overlaps, validateInstall } from "../schema/index.js";
import type { Event, Lease } from "../schema/index.js";
import type { Actor, Ctx, Result, SqlTx } from "./types.js";
import { appendEvent, fail, ok, spaceRow } from "./log.js";
import { eventActor, identity, presenceDoing, isAdmin, isExecutor } from "./identity.js";
import type { CommandContext, Handler } from "./commands.js";

export interface LeaseRow {
  mode: NonNullable<Lease["mode"]>; space: string; lease_id: string; holder: string; resources: string; state: Lease["state"];
  fence: number; rev: number; note: string | null; created_at: number; expires_at: number;
  supersedes: string | null; superseded_by: string | null;
}
const supersedes = (row: LeaseRow): string | string[] | null => row.supersedes?.startsWith("[") ? JSON.parse(row.supersedes) as string[] : row.supersedes;
const active = (l: LeaseRow) => l.state === "held" || l.state === "pending";
export function leaseView(row: LeaseRow, now: number) {
  return {
    mode: row.mode, lease_id: row.lease_id, holder: row.holder, resources: JSON.parse(row.resources) as string[],
    state: active(row) && row.expires_at <= now ? "expired" : row.state,
    fence: row.fence, rev: row.rev, note: row.note, supersedes: supersedes(row),
    expires_at: new Date(row.expires_at).toISOString(), expires_in_s: Math.max(0, (row.expires_at - now) / 1000),
  };
}
function emit(tx: SqlTx, ctx: Ctx, row: LeaseRow, op: Lease["op"], actor: Event["actor"], request: string | null): Event {
  const body: Lease = {
    type: "lease", mode: row.mode, lease_id: row.lease_id, op, state: row.state,
    resources: JSON.parse(row.resources) as string[], holder: row.holder, fence: row.fence,
    rev: row.rev, expires_at: new Date(row.expires_at).toISOString(),
    ...(row.note === null ? {} : { note: row.note }), supersedes: supersedes(row),
  };
  const git = tx.get<{ branch: string | null; head: string | null }>("SELECT branch, head FROM sessions WHERE id=?", row.holder);
  return appendEvent(tx, ctx, row.space, actor, request, body, git);
}
export function expireLeases(tx: SqlTx, ctx: Ctx, space?: string): Event[] {
  const rows = space === undefined ?
    tx.all<LeaseRow>("SELECT * FROM leases WHERE state IN ('pending','held') AND expires_at<=? ORDER BY space, fence", ctx.now()) :
    tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? AND state IN ('pending','held') AND expires_at<=? ORDER BY fence", space, ctx.now());
  return rows.map(row => {
    tx.run("UPDATE leases SET state='expired' WHERE space=? AND lease_id=?", row.space, row.lease_id);
    return emit(tx, { ...ctx, epoch: spaceRow(tx, row.space).epoch }, { ...row, state: "expired" }, "expire", { principal: "ci:relay", via: "relay", tool: "relay" }, null);
  });
}
export function revokeAllLeases(tx: SqlTx, ctx: Ctx, space: string, env?: string): void {
  for (const row of tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? AND state IN ('held','pending')", space)) {
    if (env !== undefined && row.resources !== JSON.stringify(["env:" + env])) continue;
    const updated = { ...row, state: "revoked" as const, rev: row.rev + 1 };
    tx.run("UPDATE leases SET state='revoked', rev=? WHERE space=? AND lease_id=?", updated.rev, space, row.lease_id);
    emit(tx, ctx, updated, "revoke", { principal: "ci:relay", via: "relay", tool: "relay" }, null);
  }
}
export function revokePrincipalLeases(c: CommandContext, principal: string, credential?: string): void {
  expireLeases(c.tx, c.ctx, c.actor.space);
  const rows = c.tx.all<LeaseRow>(
    "SELECT l.* FROM leases l JOIN sessions s ON s.id=l.holder WHERE l.space=? AND s.principal=? AND l.state IN ('pending','held') AND (? IS NULL OR s.credential_id=?)",
    c.actor.space, principal, credential ?? null, credential ?? null);
  for (const row of rows) transition(c, row, "revoked", "revoke");
}
function transition(c: CommandContext, row: LeaseRow, state: Lease["state"], op: Lease["op"]): Result {
  const updated = { ...row, state, rev: row.rev + 1,
    note: c.cmd.op === "lease.revoke" ? c.cmd.args.reason : row.note };
  c.tx.run("UPDATE leases SET state=?, rev=?, note=? WHERE space=? AND lease_id=?", state, updated.rev, updated.note, row.space, row.lease_id);
  emit(c.tx, c.ctx, updated, op, eventActor(c.who), c.cmd.request_id);
  return ok(c.tx, row.space, leaseView(updated, c.ctx.now()));
}

/** Exact keys/ancestor trees plus indexed ranges for descendants; no SQL LIKE wildcard semantics. */
function overlapping(tx: SqlTx, space: string, keys: string[]): LeaseRow[] {
  const found = new Map<string, LeaseRow>();
  for (const key of keys) {
    const colon = key.indexOf(":"), kind = key.slice(0, colon), name = key.slice(colon + 1);
    const exact = [key];
    if (kind === "path" || kind === "tree") {
      for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) exact.push("tree:" + name.slice(0, i + 1));
    }
    const clauses = ["k.key IN (" + exact.map(() => "?").join(",") + ")"];
    const params = [...exact];
    if (kind === "tree") {
      for (const prefix of ["path:" + name, "tree:" + name]) {
        clauses.push("(k.key>=? AND k.key<?)");
        params.push(prefix, prefix.slice(0, -1) + "0"); // "/" < "0", including every suffix.
      }
    }
    const rows = tx.all<LeaseRow>(
      "SELECT DISTINCT l.* FROM lease_keys k JOIN leases l ON l.space=k.space AND l.lease_id=k.lease_id WHERE k.space=? AND l.superseded_by IS NULL AND l.state IN ('pending','held','expired') AND (" + clauses.join(" OR ") + ")",
      space, ...params);
    for (const row of rows) found.set(row.lease_id, row);
  }
  return [...found.values()].sort((a, b) => b.fence - a.fence);
}
function displayHolder(c: CommandContext, row: LeaseRow): string {
  const holder = c.tx.get<{ principal: string; tool: string }>("SELECT principal, tool FROM sessions WHERE id=?", row.holder)!;
  return holder.principal.replace(/^(human|ci):/, "") + "/" + holder.tool + "/" + row.holder.slice(0, 4);
}
function conflict(c: CommandContext, row: LeaseRow, resources: string[]): Result {
  const doing = c.tx.get<{ doing: string }>("SELECT " + presenceDoing + " AS doing FROM sessions s JOIN presence p ON p.session=s.id WHERE s.id=?", c.ctx.now(), row.holder)?.doing || null;
  return fail(c.tx, row.space, "conflict", "Resource is held", {
    collisions: resources.flatMap(mine => (JSON.parse(row.resources) as string[]).filter(held => overlaps(mine, held)).map(held => ({ mine, held }))),
    holder: displayHolder(c, row),
    expires_at: new Date(row.expires_at).toISOString(),
    session: row.holder, lease_id: row.lease_id, rev: row.rev, note: row.note,
    age_s: Math.max(0, (c.ctx.now() - row.created_at) / 1000),
    expires_in_s: Math.max(0, (row.expires_at - c.ctx.now()) / 1000), doing,
  });
}
export const claim: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (!who.session) return fail(tx, actor.space, "not_authorized", "Holder session required");
  if (cmd.op !== "lease.claim") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  let resources: string[];
  try { resources = cmd.args.resources.map(canonicalKey); }
  catch { return fail(tx, actor.space, "invalid_resource", "Invalid lease resource"); }
  const mode = cmd.args.mode ?? "exclusive";
  const keys = resources.map(foldKey).sort();
  if (mode === "shared" && keys.some(k => k.startsWith("env:"))) return fail(tx, actor.space, "invalid_resource", "Shared leases cannot cover environments");
  if (new Set(keys).size !== keys.length || keys.some(k => k.startsWith("seq:")) ||
      (keys.some(k => k.startsWith("env:")) && keys.length !== 1))
    return fail(tx, actor.space, "invalid_resource", "Lease keys must be distinct; env leases cover one key");
  if (mode === "shared" && cmd.args.expect) return fail(tx, actor.space, "invalid_request", "Shared leases cannot be stolen");
  if (mode === "exclusive" && (cmd.args.ttl_s ?? 300) > 900) return fail(tx, actor.space, "invalid_request", "Exclusive lease TTL exceeds 900 seconds");
  expireSessions(tx, ctx);
  expireLeases(tx, ctx, actor.space);
  const matches = overlapping(tx, actor.space, keys);
  const warnings = matches.filter(row => active(row) && row.holder !== who.session && row.expires_at > ctx.now())
    .sort((a, b) => a.created_at - b.created_at || a.fence - b.fence).slice(0, 20)
    .map(row => ({ lease_id: row.lease_id, holder: displayHolder(c, row), mode: row.mode, note: row.note, resources: JSON.parse(row.resources) as string[] }));
  const rows = matches.filter(row => mode === "exclusive" && row.mode === "exclusive");
  const sameKeys = (row: LeaseRow) => JSON.stringify((JSON.parse(row.resources) as string[]).map(foldKey).sort()) === JSON.stringify(keys);
  const live = mode === "shared" ? matches.find(row => row.mode === mode && row.holder === who.session && active(row) && sameKeys(row)) : rows.find(row => active(row) && row.expires_at > ctx.now());
  const expected = cmd.args.expect;
  const expires = ctx.now() + (cmd.args.ttl_s ?? (mode === "shared" ? 3600 : 300)) * 1000;
  const hasExecutor = () => keys[0].startsWith("env:") && tx.get("SELECT 1 FROM executors WHERE space=? AND env=?", actor.space, keys[0].slice(4));
  if (live) {
    if (expected) return fail(tx, actor.space, "stale_revision", "Only expired leases can be stolen");
    if (live.holder !== who.session || !sameKeys(live)) return conflict(c, live, resources);
    if (cmd.expect_rev !== undefined && cmd.expect_rev !== live.rev) return fail(tx, actor.space, "stale_revision", "Lease revision changed");
    const updated = { ...live, state: live.state === "pending" && !hasExecutor() ? "held" as const : live.state, rev: live.rev + 1, expires_at: expires };
    tx.run("UPDATE sessions SET expires_at=? WHERE id=?", ctx.now() + 86400000, who.session);
    tx.run("UPDATE leases SET state=?, rev=?, expires_at=? WHERE space=? AND lease_id=?", updated.state, updated.rev, expires, actor.space, live.lease_id);
    if (updated.state !== live.state) emit(tx, ctx, updated, "install", eventActor(who), cmd.request_id);
    return ok(tx, actor.space, { ...leaseView(updated, ctx.now()), overlaps: warnings });
  }
  const old = expected ? rows.find(r => r.lease_id === expected.lease_id) : undefined;
  if ((expected && (!old || old.rev !== expected.rev || old.expires_at > ctx.now())) ||
      (!expected && ((keys[0].startsWith("env:") && rows.length > 0) || cmd.expect_rev !== undefined)))
    return fail(tx, actor.space, "stale_revision", "Expired lease requires a fresh claim with its expected ID and revision",
      rows[0] ? { lease_id: rows[0].lease_id, rev: rows[0].rev } : undefined);
  if (tx.get<{ value: number }>("SELECT value FROM fence_counters WHERE space=?", actor.space)!.value >= Number.MAX_SAFE_INTEGER)
    return fail(tx, actor.space, "conflict", "Fence counter exhausted");
  tx.run("UPDATE fence_counters SET value=value+1 WHERE space=?", actor.space);
  const fence = tx.get<{ value: number }>("SELECT value FROM fence_counters WHERE space=?", actor.space)!.value;
  const row: LeaseRow = {
    mode, space: actor.space, lease_id: ctx.uuid(), holder: who.session, resources: JSON.stringify(resources),
    state: hasExecutor() ? "pending" : "held", fence, rev: 1, note: cmd.args.note ?? null,
    created_at: ctx.now(), expires_at: expires, supersedes: rows.length > 1 ? JSON.stringify(rows.map(r => r.lease_id)) : old?.lease_id ?? rows[0]?.lease_id ?? null, superseded_by: null,
  };
  tx.run("INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    row.space, row.lease_id, row.holder, row.resources, row.state, row.fence, row.rev, row.note, row.created_at, row.expires_at, row.supersedes, mode);
  for (const key of keys) tx.run("INSERT INTO lease_keys VALUES (?, ?, ?)", row.space, key, row.lease_id);
  for (const previous of rows) {
    tx.run("UPDATE leases SET superseded_by=? WHERE space=? AND lease_id=?", row.lease_id, row.space, previous.lease_id);
  }
  emit(tx, ctx, row, "acquire", eventActor(who), cmd.request_id);
  return ok(tx, actor.space, { ...leaseView(row, ctx.now()), overlaps: warnings });
};
export const releaseOrRevoke: Handler = c => {
  const { tx, ctx, actor, who, cmd } = c;
  if (cmd.op !== "lease.release" && cmd.op !== "lease.revoke") return fail(tx, actor.space, "invalid_request", "Wrong operation");
  const row = tx.get<LeaseRow>("SELECT * FROM leases WHERE space=? AND lease_id=?", actor.space, cmd.args.lease_id);
  if (!row) return fail(tx, actor.space, "not_found", "Lease not found");
  const owner = tx.get<{ principal: string }>("SELECT principal FROM sessions WHERE id=?", row.holder)!.principal;
  if (cmd.op === "lease.revoke" ? !isAdmin(who) :
    (who.session !== row.holder && !(who.principal === owner && who.kind === "human")))
    return fail(tx, actor.space, "not_authorized", "Lease holder or authorized human required");
  if (!active(row) || row.expires_at <= ctx.now() || (cmd.expect_rev !== undefined && cmd.expect_rev !== row.rev))
    return fail(tx, actor.space, "stale_revision", "Lease is no longer active at this revision");
  return transition(c, row, cmd.op === "lease.revoke" ? "revoked" : "released", cmd.op === "lease.revoke" ? "revoke" : "release");
};

export function install(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown): Result {
  const who = identity(tx, ctx, actor);
  if (!who || who.kind !== "ci" || who.session) return fail(tx, actor.space, "not_authorized", "Executor CI key required");
  if (!validateInstall(input)) return fail(tx, actor.space, "invalid_request", "Invalid install fields");
  if (!isExecutor(tx, ctx, actor.space, who, input.env)) return fail(tx, actor.space, "not_authorized", "Enrolled executor key for this env and epoch required");
  const row = tx.get<LeaseRow>("SELECT * FROM leases WHERE space=? AND lease_id=?", actor.space, input.lease_id);
  if (!row) return fail(tx, actor.space, "not_found", "Lease not found");
  if (input.epoch !== ctx.epoch || row.fence !== input.fence || row.expires_at <= ctx.now() ||
      row.resources !== JSON.stringify(["env:" + input.env]) || !active(row))
    return fail(tx, actor.space, "stale_revision", "Install identity, epoch, state or deadline does not match");
  if (!input.dry_run && row.state === "held") return ok(tx, actor.space, leaseView(row, ctx.now()));
  if (row.state !== "pending" || row.fence <= input.max_fence)
    return fail(tx, actor.space, "stale_revision", "Pending lease must advance executor fence");
  if (input.dry_run) return ok(tx, actor.space, leaseView(row, ctx.now()));
  const updated = { ...row, state: "held" as const, rev: row.rev + 1 };
  tx.run("UPDATE leases SET state='held', rev=? WHERE space=? AND lease_id=?", updated.rev, actor.space, row.lease_id);
  // Executor install is an endpoint, not a command; this completion event is relay-generated.
  emit(tx, ctx, updated, "install", { principal: who.principal, via: "relay", tool: "relay" }, null);
  return ok(tx, actor.space, leaseView(updated, ctx.now()));
}
export const releaseSession: Handler = c => {
  if (c.cmd.op !== "session.release" || c.cmd.args.session !== c.who.session)
    return fail(c.tx, c.actor.space, "not_authorized", "Own session required");
  for (const row of c.tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? AND holder=? AND state IN ('held','pending')", c.actor.space, c.who.session!)) transition(c, row, "released", "release");
  c.tx.run("UPDATE presence SET state='offline' WHERE session=?", c.who.session!);
  return ok(c.tx, c.actor.space, { released: true });
};
export function expireSessions(tx: SqlTx, ctx: Ctx): Event[] {
  const events: Event[] = [];
  for (const s of tx.all<{ id: string; space: string }>("SELECT id, space FROM sessions WHERE closed=0 AND expires_at<=?", ctx.now())) {
    for (const row of tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? AND holder=? AND state IN ('held','pending')", s.space, s.id)) {
      tx.run("UPDATE leases SET state='released', rev=rev+1 WHERE space=? AND lease_id=?", s.space, row.lease_id);
      events.push(emit(tx, { ...ctx, epoch: spaceRow(tx, s.space).epoch }, { ...row, state: "released", rev: row.rev + 1 }, "release", { principal: "ci:relay", via: "relay", tool: "relay" }, null));
    }
    tx.run("UPDATE sessions SET closed=1 WHERE id=?", s.id);
    tx.run("UPDATE presence SET state='offline' WHERE session=?", s.id);
  }
  return events;
}
export function sweep(tx: SqlTx, ctx: Ctx): Event[] {
  const events = [...expireSessions(tx, ctx),...expireLeases(tx, ctx)];
  tx.run("UPDATE presence SET state='offline' WHERE expires_at<=?", ctx.now());
  return events;
}
