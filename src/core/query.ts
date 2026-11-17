import { presenceDoing } from "./identity.js";
import { liveState } from "./gates.js";
import { leaseView } from "./leases.js";
import type { LeaseRow } from "./leases.js";
import type { Event, Ask, Message, Deployment, BranchStatus } from "../schema/index.js";
import type { Result, SqlTx } from "./types.js";
import { fail, ok, spaceRow } from "./log.js";

export type Query =
  | { kind: "board"; space: string; now: number }
  | { kind: "audit"; space: string }
  | { kind: "inbox"; space: string; principal: string; session?: string }
  | { kind: "deployments"; space: string; env: string }
  | { kind: "asks"; space: string; now: number; to?: string }
  | { kind: "coordination"; space: string; now: number }
  | { kind: "events"; space: string; after?: number; limit?: number }
  | { kind: "receipt"; space: string; principal: string; session?: string; request_id: string }
  | { kind: "leases"; space: string; now: number }
  | { kind: "presence"; space: string; now: number };
/** Trusted relay read port: authenticate/authorize the caller before querying. */
export function query(tx: SqlTx, q: Query): Result {
  if (q.kind === "audit") return ok(tx, q.space, {
    head: spaceRow(tx, q.space).hash,
    exported_seq: tx.get<{ seq: number }>("SELECT seq FROM audit_state WHERE space=?", q.space)!.seq,
    lag: spaceRow(tx, q.space).seq - tx.get<{ seq: number }>("SELECT seq FROM audit_state WHERE space=?", q.space)!.seq,
  });
  if (q.kind === "board") {
    const result: Record<string, unknown> = { frozen: !!spaceRow(tx, q.space).frozen };
    for (const kind of ["coordination"] as const) {
      const part = query(tx, { kind, space: q.space, now: q.now });
      if ("result" in part) result[kind] = part.result;
    }
    const more: Record<string, boolean> = {};
    const recent = <T>(table: string, sql: string, ...args: (string | number)[]): T[] => {
      const rows = tx.all<T>(sql, ...args); more[table] = rows.length > 100; return rows.slice(0, 100);
    };
    const presence = "SELECT s.id AS session, s.principal, s.tool, COALESCE(c.device, 'default') AS device, " + presenceDoing + " AS doing, p.state, p.expires_at FROM sessions s JOIN credentials c ON c.id=s.credential_id JOIN presence p ON p.session=s.id WHERE s.space=?";
    const online = "p.state!='offline' AND p.expires_at>? AND s.expires_at>? AND s.closed=0";
    const livePresence = tx.all(presence + " AND (" + online + ")", q.now, q.space, q.now, q.now);
    const offlinePresence = recent<Record<string, unknown>>("presence", presence + " AND NOT (" + online + ") ORDER BY p.expires_at DESC LIMIT 101", q.now, q.space, q.now, q.now).map(row => ({ ...row, state: "offline" }));
    result.presence = [...livePresence, ...offlinePresence];
    const cutoff = new Date(q.now - 86400000).toISOString();
    const seq = tx.get<{ seq: number }>("SELECT seq FROM events WHERE space=? AND json_extract(event, '$.recorded_at')>=? ORDER BY json_extract(event, '$.recorded_at'), seq LIMIT 1", q.space, cutoff)?.seq ?? spaceRow(tx, q.space).seq + 1;
    for (const table of ["messages", "decisions", "deployments"] as const) {
      result[table] = recent<{ body: string }>(table, "SELECT body FROM " + table + " WHERE space=? AND seq>=? ORDER BY seq DESC LIMIT 101", q.space, seq).map(r => JSON.parse(r.body) as unknown);
      more[table] ||= !!tx.get("SELECT 1 FROM " + table + " WHERE space=? AND seq<? LIMIT 1", q.space, seq);
    }
    const liveLeases = tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? AND state IN ('held','pending') AND expires_at>? ORDER BY fence", q.space, q.now);
    const oldLeases = recent<LeaseRow>("leases", "SELECT * FROM leases WHERE space=? AND (state NOT IN ('held','pending') OR expires_at<=?) AND expires_at>=? ORDER BY fence DESC LIMIT 101", q.space, q.now, q.now - 86400000);
    more.leases ||= !!tx.get("SELECT 1 FROM leases WHERE space=? AND expires_at<? LIMIT 1", q.space, q.now - 86400000);
    result.leases = [...liveLeases, ...oldLeases].map(row => leaseView(row, q.now));
    const openAsks = tx.all<{ body: string }>("SELECT body FROM asks WHERE space=? AND (status='open' OR (json_extract(body, '$.kind')='approval' AND status!='withdrawn'))", q.space);
    const oldAsks = recent<{ body: string }>("asks", "SELECT body FROM asks WHERE space=? AND status!='open' AND (json_extract(body, '$.kind')!='approval' OR status='withdrawn') ORDER BY rowid DESC LIMIT 101", q.space);
    result.asks = [...openAsks, ...oldAsks].map(row => JSON.parse(row.body) as Ask);
    result.more = more;
    result.live = Object.fromEntries(tx.all<{ env: string }>("SELECT DISTINCT env FROM deployments WHERE space=?", q.space).map(({ env }) => [env, liveState(tx, q.space, env)]));
    const audit = query(tx, { kind: "audit", space: q.space });
    if ("result" in audit) result.audit = audit.result;
    result.reservations = recent("reservations", "SELECT sequence, value, holder, abandoned FROM reservations WHERE space=? ORDER BY rowid DESC LIMIT 101", q.space);
    return ok(tx, q.space, result);
  }
  if (q.kind === "deployments") return ok(tx, q.space, {
    live: liveState(tx, q.space, q.env) ?? null,
    history: tx.all<{ body: string }>("SELECT body FROM deployments WHERE space=? AND env=? ORDER BY exec_seq, seq", q.space, q.env).map(row => JSON.parse(row.body) as Deployment),
  });
  if (q.kind === "asks") {
    const asks = tx.all<{ body: string }>("SELECT body FROM asks WHERE space=?", q.space).map(row => JSON.parse(row.body) as Ask)
      .filter(ask => q.to === undefined || ask.to === q.to);
    return ok(tx, q.space, asks);
  }
  if (q.kind === "inbox") {
    const cursor = tx.get<{ cursor: number }>("SELECT cursor FROM inbox_cursors WHERE space=? AND principal=?", q.space, q.session && tx.get<{ tool: string }>("SELECT tool FROM sessions WHERE id=?", q.session)?.tool !== "cli" ? q.session : q.principal)?.cursor ?? 0;
    const messages = tx.all<{ seq: number; body: string }>("SELECT seq, body FROM messages WHERE space=? AND seq>? ORDER BY seq", q.space, cursor)
      .map(row => ({ seq: row.seq, body: JSON.parse(row.body) as Message }))
      .filter(row => row.body.to.includes(q.principal) || row.body.to.includes("all") || (q.session !== undefined && row.body.to.includes("session:" + q.session)));
    return ok(tx, q.space, { cursor, messages });
  }
  if (q.kind === "coordination") {
    const branches = tx.all<{ body: string }>("SELECT body FROM branch_status WHERE space=?", q.space).map(row => JSON.parse(row.body) as BranchStatus);
    const policy = tx.get<{ body: string }>("SELECT body FROM policies WHERE space=?", q.space);
    return ok(tx, q.space, { branches, policy: policy ? JSON.parse(policy.body) as unknown : {} });
  }
  if (q.kind === "leases") return ok(tx, q.space, tx.all<LeaseRow>("SELECT * FROM leases WHERE space=? ORDER BY fence", q.space).map(row => leaseView(row, q.now)));
  if (q.kind === "events") {
    const after = q.after ?? 0, limit = q.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      return fail(tx, q.space, "invalid_request", "Invalid event cursor or limit");
    const first = tx.get<{ first: number | null }>("SELECT MIN(seq) AS first FROM events WHERE space=?", q.space)?.first;
    if (after < (first === null || first === undefined ? spaceRow(tx, q.space).seq : first - 1))
      return fail(tx, q.space, "resync", "Cursor predates retained history; reload the board");
    return ok(tx, q.space, tx.all<{ event: string }>(
      "SELECT event FROM events WHERE space=? AND seq>? ORDER BY seq LIMIT ?", q.space, after, limit)
      .map(row => JSON.parse(row.event) as Event));
  }
  if (q.kind === "receipt") {
    const row = tx.get<{ response: string; payload_hash: string }>("SELECT response, payload_hash FROM receipts WHERE space=? AND principal=? AND request_id=?", q.space, q.session ? q.principal + "/" + q.session : q.principal, q.request_id);
    return row ? { ...JSON.parse(row.response) as Result, payload_hash: row.payload_hash } : fail(tx, q.space, "not_found", "Receipt not found");
  }
  return ok(tx, q.space, tx.all(
    "SELECT s.id AS session, s.principal, s.tool, COALESCE(c.device, 'default') AS device, " + presenceDoing + " AS doing, CASE WHEN p.expires_at<=? OR s.expires_at<=? OR s.closed=1 THEN 'offline' ELSE p.state END AS state FROM sessions s JOIN credentials c ON c.id=s.credential_id JOIN presence p ON p.session=s.id WHERE s.space=?",
    q.now, q.now, q.now, q.space));
}
