import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openStore } from "../src/store-sqlite/index.js";
import { migrate, createSpace } from "../src/core/index.js";
import { appendEvent, ok, withReceipt } from "../src/core/log.js";
import { eventHash, GENESIS_PREV_HASH, validateEvent } from "../src/schema/index.js";

test("transactions persist receipts and a monotonic chain, and roll back failed work", () => {
  const dir = mkdtempSync(join(tmpdir(), "xt-"));
  const path = join(dir, "db");
  let store = openStore(path);
  let now = 1000;
  const ctx = { now: () => now, uuid: randomUUID, epoch: randomUUID() };
  const space = randomUUID(), request = randomUUID();
  const actor = { principal: "human:admin", via: "human-tty" as const };
  try {
    store.tx(tx => { migrate(tx); migrate(tx); createSpace(tx, ctx, space); });
    expect(store.tx(tx => tx.get("PRAGMA journal_mode"))).toMatchObject({ journal_mode: "wal" });
    expect(store.tx(tx => tx.get("PRAGMA synchronous"))).toMatchObject({ synchronous: 2 });
    expect(store.tx(tx => tx.get("PRAGMA busy_timeout"))).toMatchObject({ timeout: 5000 });
    const command = (payload: unknown) => store.tx(tx => withReceipt(tx, space, actor.principal, request, payload, () => {
      appendEvent(tx, ctx, space, actor, request, { type: "admin", action: "principal_enrolled" });
      return ok(tx, space, { enrolled: true });
    }));
    const first = command({ a: 1 });
    expect(command({ a: 1 })).toEqual(first);
    expect(command({ a: 2 })).toMatchObject({ error: { code: "idempotency_mismatch" } });
    expect(() => store.tx(tx => { tx.run("DELETE FROM receipts"); throw new Error("rollback"); })).toThrow("rollback");
    store.close();
    store = openStore(path);
    expect(command({ a: 1 })).toEqual(first);
    now = 500;
    const second = store.tx(tx => appendEvent(tx, ctx, space, actor, randomUUID(), { type: "admin", action: "principal_revoked" }));
    const events = store.tx(tx => tx.all<{event: string}>("SELECT event FROM events ORDER BY seq").map(r => JSON.parse(r.event)));
    expect(events).toHaveLength(2);
    expect(events[0].prev_hash).toBe(GENESIS_PREV_HASH);
    expect(second.prev_hash).toBe(events[0].hash);
    expect(second.recorded_at).toBe(events[0].recorded_at);
    for (const e of events) {
      expect(validateEvent(e)).toBe(true);
      expect(e.hash).toBe(eventHash(e.prev_hash, e));
    }
  } finally { store.close(); rmSync(dir, { recursive: true }); }
}, 60_000);

test("upgrade preserves executor binding, scopes old receipts and keeps revoked credentials disabled", () => {
  const store = openStore(":memory:");
  try {
    store.tx(tx => {
      migrate(tx);
      const space = randomUUID(), session = randomUUID(), directId = randomUUID(), sessionId = randomUUID(), ctx = { now: () => 1000, uuid: randomUUID, epoch: randomUUID() };
      createSpace(tx, ctx, space);
      tx.run("INSERT INTO principals(space, principal, role, revoked) VALUES (?, 'human:test', 'member', 1)", space);
      tx.run("INSERT INTO credentials(id, space, principal, kind, secret_hash) VALUES ('old-key', ?, 'human:test', 'agent', 'old-hash')", space);
      for (const direct of [false, true]) withReceipt(tx, space, "human:test", direct ? directId : sessionId, {}, () => {
        appendEvent(tx, ctx, space, { principal: "human:test", via: direct ? "human-tty" : "agent", ...(direct ? {} : { session }) }, direct ? directId : sessionId, { type: "admin", action: "policy_set" });
        return ok(tx, space, { holder: session });
      });
      for (const index of ["credential_device", "sessions_expiry", "intents_expiry", "asks_expiry", "decisions_seq", "events_time", "events_request"]) tx.run("DROP INDEX " + index);
      for (const table of ["audit_checkpoints"]) tx.run("DROP TABLE " + table);
      for (const table of ["intents", "asks"]) for (const column of ["status", "expires"]) tx.run("ALTER TABLE " + table + " DROP COLUMN " + column);
      tx.run("ALTER TABLE principals DROP COLUMN generation");
      tx.run("ALTER TABLE credentials DROP COLUMN device");
      tx.run("ALTER TABLE credentials DROP COLUMN revoked");
      tx.run("ALTER TABLE executors DROP COLUMN principal");
      tx.run("DELETE FROM migrations WHERE version>=7");
      tx.run("INSERT INTO executors VALUES ('space', 'prod', 'epoch', 42)");
      migrate(tx);
      migrate(tx);
      expect(tx.get("SELECT principal FROM receipts WHERE request_id=?", sessionId)).toMatchObject({ principal: "human:test/" + session });
      expect(tx.get("SELECT principal FROM receipts WHERE request_id=?", directId)).toMatchObject({ principal: "human:test" });
      expect(tx.get("SELECT revoked FROM credentials WHERE id='old-key'")).toMatchObject({ revoked: 1 });
      expect(tx.get("SELECT * FROM executors")).toEqual({ space: "space", env: "prod", epoch: "epoch", max_fence: 42, principal: null });
    });
  } finally { store.close(); }
});
