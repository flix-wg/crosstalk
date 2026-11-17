import { eventHash, GENESIS_PREV_HASH, jcs, sha256, validateEvent } from "../schema/index.js";
import type { Event, Payload } from "../schema/index.js";
import type { Ctx, EventActor, Result, Space, SqlTx, ErrorCode } from "./types.js";

export function createSpace(tx: SqlTx, ctx: Ctx, space: string): void {
  tx.run("INSERT INTO spaces(space, epoch, hash) VALUES (?, ?, ?)", space, ctx.epoch, GENESIS_PREV_HASH);
  tx.run("INSERT INTO fence_counters(space) VALUES (?)", space);
  tx.run("INSERT INTO audit_state(space) VALUES (?)", space);
}
export function spaceRow(tx: SqlTx, space: string): Space {
  const row = tx.get<Space>("SELECT * FROM spaces WHERE space = ?", space);
  if (!row) throw new Error("Unknown space");
  return row;
}
export function ok<T>(tx: SqlTx, space: string, result: T): Result<T> {
  const { epoch, seq } = spaceRow(tx, space);
  return { epoch, seq, result };
}
export function fail(tx: SqlTx, space: string, code: ErrorCode, message: string, details?: unknown): Result<never> {
  const { epoch, seq } = spaceRow(tx, space);
  return { epoch, seq, error: { code, message, ...(details === undefined ? {} : { details }) } };
}
export function appendEvent(tx: SqlTx, ctx: Ctx, space: string, actor: EventActor,
  request_id: string | null, body: Payload, git: Event["git"] = { branch: null, head: null }): Event {
  const row = spaceRow(tx, space);
  const at = Math.max(ctx.now(), row.last_at);
  const unsigned: Omit<Event, "hash"> = {
    v: 2, space, epoch: ctx.epoch, seq: row.seq + 1, id: ctx.uuid(), request_id,
    recorded_at: new Date(at).toISOString(), actor, git, prev_hash: row.hash, body,
  };
  const event = { ...unsigned, hash: eventHash(row.hash, unsigned) };
  if (row.epoch !== ctx.epoch || !validateEvent(event)) throw new Error("Invalid internal event");
  tx.run("INSERT INTO events VALUES (?, ?, ?)", space, event.seq, JSON.stringify(event));
  tx.run("INSERT INTO outbox VALUES (?, ?)", space, event.seq);
  tx.run("UPDATE spaces SET seq = ?, last_at = ?, hash = ? WHERE space = ?", event.seq, at, event.hash, space);
  return event;
}
/** Caller authenticates first. Both domain failures and successes are durable outcomes. */
export function withReceipt(tx: SqlTx, space: string, principal: string, requestId: string,
  payload: unknown, fn: () => Result): Result {
  const hash = sha256(jcs(payload));
  const previous = tx.get<{ payload_hash: string; response: string }>(
    "SELECT payload_hash, response FROM receipts WHERE space = ? AND principal = ? AND request_id = ?",
    space, principal, requestId);
  if (previous) return previous.payload_hash === hash ? JSON.parse(previous.response) as Result :
    fail(tx, space, "idempotency_mismatch", "Request ID was already used with another payload");
  const response = fn();
  const result = "error" in response ? response : { ...response, receipt: requestId };
  tx.run("INSERT INTO receipts VALUES (?, ?, ?, ?, ?)", space, principal, requestId, hash, JSON.stringify(result));
  return result;
}
