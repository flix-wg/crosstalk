import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../schema/index.js";
import { ClientError } from "./config.js";
import { scanSecrets } from "./render.js";

const SCHEMA = 1;
export interface CachedBoard { epoch: string; seq: number; snapshot: unknown; fetched_at: number }
export class LocalCache {
  private readonly db: DatabaseSync;
  constructor(commonDir: string, private readonly scope: string, options: { fastMetadata?: boolean } = {}) {
    const dir = join(commonDir, "crosstalk");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, "cache.sqlite"));
    // Hooks write reconstructible metadata; NORMAL avoids per-write fsync delays. Several agents of one
    // developer share this file, so a hook skips a metadata write that would outwait its budget (soft).
    this.soft = !!options.fastMetadata;
    this.db.exec("PRAGMA busy_timeout=" + (this.soft ? 150 : 5000) + "; PRAGMA journal_mode=WAL; PRAGMA synchronous=" + (options.fastMetadata ? "NORMAL" : "FULL"));
    // Setup takes the write lock, so it runs once per file instead of on every hook.
    if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) < SCHEMA) {
      this.db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      try {
        if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) < SCHEMA) {
          this.db.exec("CREATE TABLE IF NOT EXISTS local_state(scope TEXT PRIMARY KEY, epoch TEXT, cursor INTEGER NOT NULL DEFAULT 0, board TEXT); CREATE TABLE IF NOT EXISTS reservation_receipts(scope TEXT, request_id TEXT, receipt TEXT NOT NULL, PRIMARY KEY(scope,request_id)); CREATE TABLE IF NOT EXISTS local_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, request_id TEXT NOT NULL, command TEXT NOT NULL, UNIQUE(scope,request_id)); CREATE TABLE IF NOT EXISTS local_values(scope TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(scope,key)); CREATE TABLE IF NOT EXISTS local_locks(scope TEXT, key TEXT, owner TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(scope,key))");
          // Legacy queues did not record a session; replaying them could impersonate a different session.
          this.db.exec("DELETE FROM local_outbox WHERE scope NOT LIKE '%/outbox/%'; PRAGMA user_version=" + SCHEMA);
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      if (this.soft) this.db.exec("PRAGMA busy_timeout=150");
    }
    chmodSync(join(dir, "cache.sqlite"), 0o600);
    if (!this.db.prepare("SELECT 1 FROM local_state WHERE scope=?").get(scope)) this.write(() => this.db.prepare("INSERT OR IGNORE INTO local_state(scope) VALUES (?)").run(scope));
  }
  /** Metadata writes made by hooks; skipped when another process holds the lock past the short wait. */
  skipped = 0;
  private soft: boolean;
  private write(run: () => void): void {
    try { run(); } catch (error) {
      if (!this.soft || !/database is locked|SQLITE_BUSY/.test(String((error as Error).message))) throw error;
      this.skipped++;
    }
  }
  lock(key: string, owner: string, now: number): boolean {
    let won = false;
    this.write(() => { won = this.db.prepare("INSERT INTO local_locks VALUES (?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE local_locks.expires<=?").run(this.scope, key, owner, now + 15000, now).changes === 1; });
    return won;
  }
  /** Writes that must land even in a hook: a lost unlock stalls the next hook; a lost session record opens a duplicate session. */
  strict<T>(run: () => T): T {
    if (!this.soft) return run();
    this.db.exec("PRAGMA busy_timeout=2000");
    this.soft = false;
    try { return run(); } finally { this.soft = true; this.db.exec("PRAGMA busy_timeout=150"); }
  }
  unlock(key: string, owner: string): void {
    this.strict(() => this.db.prepare("DELETE FROM local_locks WHERE scope=? AND key=? AND owner=?").run(this.scope, key, owner));
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM local_values WHERE scope=? AND key=?").get(this.scope, key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.write(() => this.db.prepare("INSERT OR REPLACE INTO local_values VALUES (?,?,?)").run(this.scope, key, JSON.stringify(value)));
  }
  union(key: string, values: string[]): void {
    this.write(() => this.db.prepare("INSERT INTO local_values VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(local_values.value) UNION SELECT value FROM json_each(excluded.value)))").run(this.scope, key, JSON.stringify([...new Set(values)])));
  }
  setNewest(key: string, value: { at: number }): void {
    this.write(() => this.db.prepare("INSERT INTO local_values VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value WHERE json_extract(excluded.value,'$.at')>=json_extract(local_values.value,'$.at')").run(this.scope, key, JSON.stringify(value)));
  }
  observeEpoch(epoch: string): boolean {
    const row = this.db.prepare("SELECT epoch FROM local_state WHERE scope=?").get(this.scope);
    const changed = typeof row?.epoch === "string" && row.epoch !== epoch;
    if (changed) this.set("events", []);
    if (row?.epoch !== epoch) this.db.prepare("UPDATE local_state SET epoch=?, cursor=0, board=NULL WHERE scope=?").run(epoch, this.scope);
    return changed;
  }
  saveBoard(board: CachedBoard): void {
    this.write(() => {
      this.observeEpoch(board.epoch);
      this.db.prepare("UPDATE local_state SET board=?, cursor=? WHERE scope=?").run(JSON.stringify(board), board.seq, this.scope);
    });
  }
  board(): CachedBoard | undefined {
    const row = this.db.prepare("SELECT board FROM local_state WHERE scope=?").get(this.scope);
    return typeof row?.board === "string" ? JSON.parse(row.board) as CachedBoard : undefined;
  }
  cursor(): number { return Number(this.db.prepare("SELECT cursor FROM local_state WHERE scope=?").get(this.scope)?.cursor ?? 0); }
  setCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ClientError("invalid_cursor", "Invalid event cursor");
    this.write(() => this.db.prepare("UPDATE local_state SET cursor=MAX(cursor, ?) WHERE scope=?").run(cursor, this.scope));
  }
  saveReservation(request_id: string, receipt: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO reservation_receipts VALUES (?,?,?)").run(this.scope, request_id, JSON.stringify(receipt));
  }
  reservations(): unknown[] {
    return this.db.prepare("SELECT receipt FROM reservation_receipts WHERE scope=?").all(this.scope).map(r => JSON.parse(String(r.receipt)) as unknown);
  }
  enqueue(command: Command, session = "legacy"): void {
    if (!["message.send", "intent.post", "intent.close", "ask.open"].includes(command.op))
      throw new ClientError("not_queueable", "Only messages, intents and asks can be queued offline");
    scanSecrets(command.args);
    const json = JSON.stringify(command);
    const old = this.db.prepare("SELECT command FROM local_outbox WHERE scope=? AND request_id=?").get(this.scope + "/outbox/" + session, command.request_id);
    if (old && old.command !== json) throw new ClientError("idempotency_mismatch", "Queued request ID has different content");
    this.db.prepare("INSERT OR IGNORE INTO local_outbox(scope,request_id,command) VALUES (?,?,?)").run(this.scope + "/outbox/" + session, command.request_id, json);
  }
  pending(session = "legacy"): Command[] {
    return this.db.prepare("SELECT command FROM local_outbox WHERE scope=? ORDER BY id").all(this.scope + "/outbox/" + session).map(r => JSON.parse(String(r.command)) as Command);
  }
  delivered(request_id: string, session = "legacy"): void {
    this.db.prepare("DELETE FROM local_outbox WHERE scope=? AND request_id=?").run(this.scope + "/outbox/" + session, request_id);
  }
  discardOutbox(session: string): void {
    this.db.prepare("DELETE FROM local_outbox WHERE scope=?").run(this.scope + "/outbox/" + session);
  }
  close(): void { this.db.close(); }
}
