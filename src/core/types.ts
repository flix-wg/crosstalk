import type { Event } from "../schema/index.js";

export type SqlValue = string | number | bigint | Uint8Array | null;
export interface SqlTx {
  run(sql: string, ...p: SqlValue[]): { changes: number };
  all<T>(sql: string, ...p: SqlValue[]): T[];
  get<T>(sql: string, ...p: SqlValue[]): T | undefined;
}
export interface Store { tx<T>(fn: (t: SqlTx) => T): T }
/** Relay supplies an Ed25519 implementation; signatures cover canonical UTF-8 JSON. */
export interface Signer { algorithm: "Ed25519"; sign(payload: string): string; verify(payload: string, signature: string): boolean }
export interface Ctx { now(): number; uuid(): string; epoch: string; signer?: Signer; auditExporter?: string }
export type ErrorCode = "unsupported_op" | "unsupported_version" | "resync" | "conflict" | "stale_revision" | "not_authorized" | "invalid_resource" |
  "invalid_request" | "payload_too_large" | "rate_limited" | "frozen" | "not_found" | "idempotency_mismatch";
export type Result<T = unknown> =
  | { payload_hash?: string; epoch: string; seq: number; result: T; receipt?: string }
  | { payload_hash?: string; epoch: string; seq: number; error: { code: ErrorCode; message: string; details?: unknown } };
export interface Actor {
  space: string;
  principal: string;
  credential_id: string;
  session?: string;
}
export interface Space { space: string; epoch: string; seq: number; last_at: number; hash: string; frozen: number }
export type EventActor = Event["actor"];
