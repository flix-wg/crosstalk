import type { Event } from "../src/schema/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventHash, validateEvent, exportChain } from "../src/schema/index.js";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { openStore } from "../src/store-sqlite/index.js";
import { attestAudit, migrate, createSpace, bootstrapAdmin, issueCredential, authenticate, openSession, execute, heartbeat, query, install, sweep } from "../src/core/index.js";
import type { Actor, Result, SqlTx, SqlValue } from "../src/core/index.js";

function value<T>(r: Result): T {
  if ("error" in r) throw new Error(r.error.code);
  return r.result as T;
}
function setup(path = ":memory:") {
  const store = openStore(path);
  let now = 1_000_000;
  const ctx = { now: () => now, uuid: randomUUID, epoch: randomUUID() };
  const space = randomUUID();
  const secret = () => randomUUID() + randomUUID();
  const adminSecret = secret();
  store.tx(tx => { migrate(tx); createSpace(tx, ctx, space); bootstrapAdmin(tx, ctx, space, "human:admin", adminSecret); });
  const admin = store.tx(tx => authenticate(tx, ctx, space, adminSecret))!;
  const command = (actor: Actor, op: string, args: unknown, extra = {}) =>
    store.tx(tx => execute(tx, ctx, actor, { request_id: randomUUID(), op, args, ...extra }));
  const metadata = { tool: "codex", harness_session_id: "harness-1", machine: "test", worktree: null, branch: null, head: null };
  const key = (principal: string, kind: "human" | "agent" | "ci") => {
    const raw = secret();
    value(store.tx(tx => issueCredential(tx, ctx, admin, principal, kind, raw)));
    return store.tx(tx => authenticate(tx, ctx, space, raw))!;
  };
  const session = (credential: Actor, tool = "codex") => {
    const token = secret();
    value(store.tx(tx => openSession(tx, ctx, credential, { ...metadata, tool }, token)));
    return store.tx(tx => authenticate(tx, ctx, space, token))!;
  };
  return { store, ctx, space, admin, command, metadata, key, session, secret, setTime: (t: number) => { now = t; } };
}

test("key kinds constrain sessions; revocation disables keys and existing session tokens", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:member", role: "member" }));
    value(f.command(f.admin, "principal.invite", { principal: "ci:runner", role: "ci" }));
    const agent = f.key("human:member", "agent"), human = f.key("human:member", "human"), ci = f.key("ci:runner", "ci");
    for (const tool of ["codex", "claude-code", "mcp", "cli"]) expect(f.session(agent, tool).session).toBeTruthy();
    expect(f.session(ci, "ci").session).toBeTruthy();
    for (const [key, tool] of [[human, "cli"], [ci, "codex"], [agent, "ci"]] as const) {
      expect(f.store.tx(tx => openSession(tx, f.ctx, key, { ...f.metadata, tool }, f.secret())))
        .toMatchObject({ error: { code: "not_authorized" } });
    }
    expect(f.command(agent, "principal.invite", { principal: "human:no", role: "admin" })).toMatchObject({ error: { code: "not_authorized" } });
    const s = f.session(agent);
    value(f.command(f.admin, "principal.revoke", { principal: "human:member" }));
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, s, "working"))).toMatchObject({ error: { code: "not_authorized" } });
    expect(f.store.tx(tx => openSession(tx, f.ctx, agent, f.metadata, f.secret()))).toMatchObject({ error: { code: "not_authorized" } });
    for (const row of f.store.tx(tx => tx.all<{ secret_hash: string }>("SELECT secret_hash FROM credentials"))) {
      expect(row.secret_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  } finally { f.store.close(); }
});

test("presence expires at 90 seconds without events; sessions expire at 24 hours", () => {
  const f = setup();
  try {
    const s = f.session(f.key("human:admin", "agent"));
    const seq = f.store.tx(tx => query(tx, { kind: "events", space: f.space })).seq;
    value(f.store.tx(tx => heartbeat(tx, f.ctx, s, "waiting", "review")));
    f.setTime(1_090_000);
    expect(value(f.store.tx(tx => query(tx, { kind: "presence", space: f.space, now: f.ctx.now() })))).toMatchObject([{ state: "offline", doing: "review" }]);
    expect(f.store.tx(tx => query(tx, { kind: "events", space: f.space })).seq).toBe(seq);
    f.setTime(1_000_000 + 86400000);
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, s, "working"))).toMatchObject({ error: { code: "not_authorized" } });
  } finally { f.store.close(); }
});

interface LeaseResult { supersedes: string | string[] | null; lease_id: string; fence: number; rev: number; state: string; expires_in_s: number }
test("two connections make 100 interleaved overlapping claims each with only one holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "xt-claims-"));
  const path = join(dir, "db");
  const f = setup(path);
  const other = openStore(path);
  try {
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:admin", "agent"));
    const held = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["tree:api/"] }));
    for (let i = 0; i < 100; i++) {
      const attempt = other.tx(tx => execute(tx, f.ctx, b, {
        request_id: randomUUID(), op: "lease.claim", args: { resources: [i % 2 ? "path:API/X.py" : "tree:Api/"] },
      }));
      expect(attempt).toMatchObject({ error: { code: "conflict", details: { lease_id: held.lease_id, doing: null, expires_in_s: 300 } } });
      const renewed = value<LeaseResult>(f.command(a, "lease.claim", { resources: [i % 2 ? "tree:API/" : "tree:api/"] }));
      expect(renewed).toMatchObject({ lease_id: held.lease_id, fence: held.fence, rev: i + 2 });
      expect(f.store.tx(tx => tx.all("SELECT * FROM leases WHERE state='held'"))).toHaveLength(1);
    }
    value(f.command(a, "lease.claim", { mode: "shared", note: "older", resources: ["tree:api/"] }));
    f.setTime(1_000_001);
    value(f.command(a, "lease.claim", { mode: "shared", note: "newest", resources: ["path:api/x"] }));
    expect(f.command(b, "lease.claim", { resources: ["path:api/x.py"] }))
      .toMatchObject({ error: { details: { doing: "newest" } } });
    // A literal SQL wildcard in a key must not overlap a different filename.
    value(f.command(b, "lease.claim", { resources: ["tree:a%/"] }));
    value(f.command(a, "lease.claim", { resources: ["path:abc/file"] }));
    expect(f.command(b, "lease.claim", { resources: ["tree:ab/"] })).toHaveProperty("result");
    const log = value<unknown[]>(f.store.tx(tx => query(tx, { kind: "events", space: f.space })));
    expect(log).toHaveLength(7); // bootstrap, two shared and four exclusive acquisitions; renewals have no events.
  } finally { other.close(); f.store.close(); rmSync(dir, { recursive: true }); }
}, 180_000);

test("renewal loses at the deadline; stealing uses the old revision and a greater fence", () => {
  const f = setup();
  try {
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:admin", "agent"));
    let first = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["path:API/x.py"], ttl_s: 30 }));
    f.setTime(1_029_999);
    expect(f.command(b, "lease.claim", { resources: ["tree:api/"], expect: { lease_id: first.lease_id, rev: first.rev } }))
      .toMatchObject({ error: { code: "stale_revision" } });
    first = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["path:API/x.py"], ttl_s: 30 }, { expect_rev: first.rev }));
    f.setTime(1_030_000);
    expect(f.command(b, "lease.claim", { resources: ["tree:api/"], expect: { lease_id: first.lease_id, rev: first.rev } }))
      .toMatchObject({ error: { code: "stale_revision" } });
    f.setTime(1_059_999);
    expect(f.command(a, "lease.claim", { resources: ["path:api/X.py"], ttl_s: 30 }, { expect_rev: first.rev }))
      .toMatchObject({ error: { code: "stale_revision" } });
    expect(f.command(b, "lease.claim", { resources: ["tree:api/"], expect: { lease_id: first.lease_id, rev: first.rev + 1 } }))
      .toMatchObject({ error: { code: "stale_revision" } });
    const next = value<LeaseResult>(f.command(b, "lease.claim", { resources: ["tree:api/"], expect: { lease_id: first.lease_id, rev: first.rev } }));
    expect(next.fence).toBe(first.fence + 1);
    expect(next.lease_id).not.toBe(first.lease_id);
    expect(f.store.tx(tx => sweep(tx, f.ctx))).toEqual([]);
    const events = value<Array<{body: {op?: string; supersedes?: string}}>>(f.store.tx(tx => query(tx, { kind: "events", space: f.space })));
    expect(events.map(e => e.body.op).filter(Boolean)).toEqual(["acquire", "expire", "acquire"]);
    expect(events.at(-1)?.body.supersedes).toBe(first.lease_id);
    f.setTime(1_359_999);
    expect(f.store.tx(tx => sweep(tx, f.ctx))).toHaveLength(1);
    expect(f.store.tx(tx => sweep(tx, f.ctx))).toHaveLength(0);
  } finally { f.store.close(); }
});

test("shared and exclusive claims report peers without blocking each other", () => {
  const f = setup();
  try {
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:admin", "agent"));
    const args = { mode: "shared", resources: ["tree:api/"], note: "Review" };
    const shared = value<LeaseResult>(f.command(a, "lease.claim", args));
    expect(f.command(b, "lease.claim", { resources: ["path:api/file"] })).toMatchObject({
      result: { mode: "exclusive", overlaps: [{ lease_id: shared.lease_id, mode: "shared", note: "Review" }] },
    });
    expect(f.command(a, "lease.claim", { ...args, resources: ["path:api/file"] })).toMatchObject({
      result: { mode: "shared", overlaps: [{ mode: "exclusive" }], supersedes: null },
    });
    expect(f.command(a, "lease.claim", { ...args, note: "Changed" })).toMatchObject({
      result: { lease_id: shared.lease_id, mode: "shared", note: "Review", rev: 2, overlaps: [{ mode: "exclusive" }] },
    });
    expect(f.command(a, "lease.claim", { ...args, resources: ["env:prod"] })).toMatchObject({ error: { code: "invalid_resource" } });
    expect(f.command(a, "lease.claim", { ...args, expect: { lease_id: shared.lease_id, rev: 2 } })).toMatchObject({ error: { code: "invalid_request" } });
    expect(f.command(a, "lease.claim", { resources: ["path:x"], ttl_s: 901 })).toMatchObject({ error: { code: "invalid_request" } });
    expect(f.command(a, "lease.claim", { resources: ["env:prod"] })).toMatchObject({ result: { state: "held" } });
  } finally { f.store.close(); }
});

test("env installation validates before mutation, acknowledges once, and accepts a lost-ack retry", () => {
  const f = setup();
  try {
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:admin", "agent"));
    value(f.command(f.admin, "principal.invite", { principal: "ci:executor", role: "ci" }));
    const executor = f.key("ci:executor", "ci");
    value(f.command(f.admin, "executor.enroll", { env: "prod", executor: "ci:executor", max_fence: 0 }));
    expect(f.command(a, "lease.claim", { resources: ["env:prod", "path:api/x"] })).toMatchObject({ error: { code: "invalid_request" } });
    const lease = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["env:prod"] }));
    expect(lease.state).toBe("pending");
    expect(f.command(b, "lease.claim", { resources: ["env:prod"] })).toMatchObject({ error: { code: "conflict" } });
    const input = { epoch: f.ctx.epoch, lease_id: lease.lease_id, fence: lease.fence, env: "prod", max_fence: 0, dry_run: true };
    const call = (changes = {}, actor = executor) => f.store.tx(tx => install(tx, f.ctx, actor, { ...input, ...changes }));
    expect(call({}, a)).toMatchObject({ error: { code: "not_authorized" } });
    expect(call({ env: "other" })).toMatchObject({ error: { code: "not_authorized" } });
    for (const change of [{ epoch: randomUUID() }, { fence: lease.fence + 1 }, { max_fence: lease.fence }])
      expect(call(change)).toMatchObject({ error: { code: "stale_revision" } });
    const seq = call().seq;
    expect(value<LeaseResult>(call()).state).toBe("pending");
    const ack = call({ dry_run: false });
    expect(value<LeaseResult>(ack)).toMatchObject({ state: "held", fence: lease.fence });
    expect(ack.seq).toBe(seq + 1);
    expect(call({ dry_run: false, max_fence: lease.fence })).toEqual(ack);
    expect(call()).toMatchObject({ error: { code: "stale_revision" } });
    f.setTime(1_300_000);
    expect(call({ dry_run: false })).toMatchObject({ error: { code: "stale_revision" } });
  } finally { f.store.close(); }
});

test("release and admin/principal revocation remove authority and preserve tombstones", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:member", role: "member" }));
    const a = f.session(f.key("human:member", "agent")), other = f.session(f.key("human:admin", "agent"));
    const lease = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["path:x"] }));
    expect(f.command(other, "lease.release", { lease_id: lease.lease_id })).toMatchObject({ error: { code: "not_authorized" } });
    // A session calling itself cli is still an agent-key session: no release of sibling sessions' leases.
    expect(f.command(f.session(f.key("human:member", "agent"), "cli"), "lease.release", { lease_id: lease.lease_id })).toMatchObject({ error: { code: "not_authorized" } });
    expect(f.session(f.key("human:member", "agent"), "my-harness")).toHaveProperty("session");
    const memberKey = f.key("human:member", "agent");
    expect(f.store.tx(tx => openSession(tx, f.ctx, memberKey, { ...f.metadata, tool: "Bad Tool" }, f.secret()))).toMatchObject({ error: { code: "invalid_request" } });
    expect(f.command(a, "lease.release", { lease_id: lease.lease_id }, { expect_rev: 2 })).toMatchObject({ error: { code: "stale_revision" } });
    const request = randomUUID(), payload = { lease_id: lease.lease_id };
    const released = f.command(a, "lease.release", payload, { request_id: request, expect_rev: 1 });
    expect(value<LeaseResult>(released).state).toBe("released");
    expect(f.command(a, "lease.release", payload, { request_id: request, expect_rev: 1 })).toEqual(released);
    const second = value<LeaseResult>(f.command(a, "lease.claim", { resources: ["path:x"] }));
    expect(f.command(a, "lease.revoke", { lease_id: second.lease_id, reason: "test" })).toMatchObject({ error: { code: "not_authorized" } });
    expect(value<LeaseResult>(f.command(f.admin, "lease.revoke", { lease_id: second.lease_id, reason: "test" })).state).toBe("revoked");
    value(f.command(a, "lease.claim", { resources: ["env:prod"] }));
    value(f.command(a, "lease.claim", { resources: ["path:y"] }));
    value(f.command(f.admin, "principal.revoke", { principal: "human:member" }));
    const states = f.store.tx(tx => tx.all<{state: string}>("SELECT state FROM leases ORDER BY fence").map(r => r.state));
    expect(states).toEqual(["released", "revoked", "revoked", "revoked"]);
    expect(f.store.tx(tx => tx.get("SELECT note FROM leases WHERE lease_id=?", second.lease_id))).toMatchObject({ note: "test" });
    const events = value<import("../src/schema/index.js").Event[]>(f.store.tx(tx => query(tx, { kind: "events", space: f.space })));
    for (const [i, event] of events.entries()) {
      expect(validateEvent(event)).toBe(true);
      expect(event.hash).toBe(eventHash(event.prev_hash, event));
      if (i) expect(event.prev_hash).toBe(events[i - 1].hash);
      expect(event.seq).toBe(i + 1);
    }
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, a, "working"))).toMatchObject({ error: { code: "not_authorized" } });
  } finally { f.store.close(); }
});

test("expired file leases allow narrower claims and record every replacement; env still requires expect", () => {
  const f = setup();
  try {
    for (const principal of ["human:carol", "human:dave"]) value(f.command(f.admin, "principal.invite", { principal, role: "member" }));
    const carol = f.session(f.key("human:carol", "agent")), dave = f.session(f.key("human:dave", "agent"));
    const first = value<LeaseResult>(f.command(carol, "lease.claim", { resources: ["tree:src/"], ttl_s: 30 }));
    const second = value<LeaseResult>(f.command(carol, "lease.claim", { resources: ["path:other/x"], ttl_s: 30 }));
    const env = value<LeaseResult>(f.command(carol, "lease.claim", { resources: ["env:prod"], ttl_s: 30 }));
    f.setTime(1_030_000);
    const next = value<LeaseResult>(f.command(dave, "lease.claim", { resources: ["path:src/x.py", "path:other/x"] }));
    expect(next.fence).toBeGreaterThan(env.fence);
    expect((next.supersedes as string[]).sort()).toEqual([first.lease_id, second.lease_id].sort());
    expect(f.command(dave, "lease.claim", { resources: ["env:prod"] })).toMatchObject({ error: { code: "stale_revision" } });
    expect(f.command(dave, "lease.claim", { resources: ["env:prod"], expect: { lease_id: env.lease_id, rev: env.rev } })).toHaveProperty("result");
  } finally { f.store.close(); }
});

test("heartbeats and lease renewal slide session expiry; expired sessions release long leases", () => {
  const f = setup();
  try {
    const key = f.key("human:admin", "agent"), old = f.session(key);
    f.setTime(1_000_000 + 86300000);
    value(f.store.tx(tx => heartbeat(tx, f.ctx, old, "working")));
    f.setTime(1_000_000 + 86400000);
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, old, "working"))).toHaveProperty("result");
    const lease = value<LeaseResult>(f.command(old, "lease.claim", { resources: ["path:old"], ttl_s: 900 }));
    f.setTime(f.ctx.now() + 1000);
    value(f.command(old, "lease.claim", { resources: ["path:old"], ttl_s: 900 }));
    expect(f.store.tx(tx => tx.get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id=?", old.session!)!.expires_at)).toBe(f.ctx.now() + 86400000);
    // A persisted lease may outlast its session (older data or a policy change).
    f.store.tx(tx => tx.run("UPDATE leases SET expires_at=? WHERE lease_id=?", f.ctx.now() + 172800000, lease.lease_id));
    f.setTime(f.ctx.now() + 86400000);
    const fresh = f.session(key);
    expect(f.command(fresh, "lease.claim", { resources: ["path:old"] })).toHaveProperty("result");
    expect(f.store.tx(tx => tx.get("SELECT state FROM leases WHERE lease_id=?", lease.lease_id))).toMatchObject({ state: "released" });
  } finally { f.store.close(); }
});

test("device revocation is isolated and reinvitation never revives old credentials", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:member", role: "member" }));
    const keys = ["laptop", "desktop"].map(device => {
      const secret = f.secret(); value(f.store.tx(tx => issueCredential(tx, f.ctx, f.admin, "human:member", "agent", secret, device)));
      return f.store.tx(tx => authenticate(tx, f.ctx, f.space, secret))!;
    });
    const sessions = keys.map(k => f.session(k));
    value(f.command(sessions[0], "lease.claim", { resources: ["path:device"] }));
    value(f.command(f.admin, "principal.revoke", { principal: "human:member", device: "laptop" }));
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, sessions[0], "working"))).toHaveProperty("error");
    expect(f.store.tx(tx => heartbeat(tx, f.ctx, sessions[1], "working"))).toHaveProperty("result");
    expect(f.command(sessions[1], "lease.claim", { resources: ["path:device"] })).toHaveProperty("result");
    expect(value(f.store.tx(tx => query(tx, { kind: "presence", space: f.space, now: f.ctx.now() })))).toEqual(expect.arrayContaining([expect.objectContaining({ device: "desktop" })]));
    value(f.command(f.admin, "principal.revoke", { principal: "human:member" }));
    value(f.command(f.admin, "principal.invite", { principal: "human:member", role: "member" }));
    for (const key of keys) expect(f.store.tx(tx => openSession(tx, f.ctx, key, f.metadata, f.secret()))).toHaveProperty("error");
    expect(f.session(f.key("human:member", "agent"))).toHaveProperty("session");
  } finally { f.store.close(); }
});

test("inbox acknowledgments and receipts are isolated between sessions; CLI cursor stays principal-wide", () => {
  const f = setup();
  try {
    const key = f.key("human:admin", "agent"), a = f.session(key), b = f.session(key), cli = f.session(key, "cli"), cli2 = f.session(key, "cli");
    const sent = f.command(a, "message.send", { to: ["human:admin", "session:" + b.session], context_id: randomUUID(), parts: [{ kind: "text", text: "hello" }] });
    value(f.command(a, "inbox.ack", { cursor: sent.seq }));
    const inbox = (actor: Actor) => value<{ messages: unknown[] }>(f.store.tx(tx => query(tx, { kind: "inbox", space: f.space, principal: actor.principal, session: actor.session })));
    expect(inbox(a).messages).toHaveLength(0); expect(inbox(b).messages).toHaveLength(1);
    value(f.command(cli, "inbox.ack", { cursor: sent.seq })); expect(inbox(cli2).messages).toHaveLength(0); expect(inbox(b).messages).toHaveLength(1);
    const request_id = randomUUID(), first = f.command(a, "lease.claim", { resources: ["path:receipt"] }, { request_id });
    expect(first).toHaveProperty("result");
    expect(f.store.tx(tx => query(tx, { kind: "receipt", space: f.space, principal: b.principal, session: b.session, request_id }))).toMatchObject({ error: { code: "not_found" } });
    expect(f.command(b, "lease.claim", { resources: ["path:receipt"] }, { request_id })).toMatchObject({ error: { code: "conflict" } });
  } finally { f.store.close(); }
});

test("admin enrollment, human ask targets, and frozen/idempotent abandonment are enforced", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:member", role: "member" }));
    value(f.command(f.admin, "principal.invite", { principal: "ci:executor", role: "ci" }));
    const member = f.key("human:member", "human"), agent = f.session(f.key("human:member", "agent"));
    expect(f.command(member, "executor.enroll", { env: "prod", executor: "ci:executor", max_fence: 0 })).toMatchObject({ error: { code: "not_authorized" } });
    expect(f.command(agent, "ask.open", { kind: "question", to: "ci:executor", question: "Ready?" })).toHaveProperty("error");
    value(f.command(agent, "reserve", { sequence: "seq:test" }));
    const abandoned = f.command(agent, "reserve", { sequence: "seq:test", abandon: 1 });
    expect(f.command(agent, "reserve", { sequence: "seq:test", abandon: 1 }).seq).toBe(abandoned.seq);
    value(f.command(f.admin, "space.freeze", {}));
    expect(f.command(agent, "reserve", { sequence: "seq:test", abandon: 1 })).toMatchObject({ error: { code: "frozen" } });
  } finally { f.store.close(); }
});

test("board history is capped while live leases remain visible; sweeps use expiry indexes", () => {
  const f = setup();
  try {
    const agent = f.session(f.key("human:admin", "agent"));
    for (let i = 0; i < 105; i++) value(f.command(agent, "message.send", { to: ["all"], context_id: randomUUID(), parts: [{ kind: "text", text: String(i) }] }));
    value(f.command(agent, "lease.claim", { resources: ["tree:src/"] }));
    const board = value<{ messages: unknown[]; leases: unknown[]; more: Record<string, boolean> }>(f.store.tx(tx => query(tx, { kind: "board", space: f.space, now: f.ctx.now() })));
    expect(board.messages).toHaveLength(100); expect(board.more.messages).toBe(true); expect(board.leases).toHaveLength(1);
    for (const [table, state] of [["asks", "open"]]) {
      const plan = f.store.tx(tx => tx.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE status=? AND expires<=?`, state, f.ctx.now()));
      expect(plan.map(p => p.detail).join(" ")).toContain(table + "_expiry");
    }
  } finally { f.store.close(); }
});

test("audit attestations verify only the suffix after a persisted checkpoint and reject unrelated CI", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "ci:other", role: "ci" }));
    const other = f.key("ci:other", "ci");
    const ctx = { ...f.ctx, signer: { algorithm: "Ed25519" as const, sign: () => "signature", verify: () => true } };
    let count = 0;
    const attest = () => f.store.tx(tx => {
      const events = value<Event[]>(query(tx, { kind: "events", space: f.space }));
      const xhash = exportChain(events).at(-1)!.xhash;
      const traced: SqlTx = { ...tx, all<T>(sql: string, ...args: SqlValue[]): T[] {
        const rows = tx.all<T>(sql, ...args); if (sql.startsWith("SELECT event FROM events")) count += rows.length; return rows;
      } };
      return value(attestAudit(traced, ctx, f.admin, { through_seq: events.at(-1)!.seq, xhash }, "test-key"));
    });
    attest(); const initial = count; expect(initial).toBeGreaterThan(0);
    value(f.command(f.admin, "message.send", { to: ["all"], context_id: randomUUID(), parts: [{ kind: "text", text: "suffix" }] }));
    attest(); expect(count).toBe(initial + 1); attest(); expect(count).toBe(initial + 1);
    expect(f.store.tx(tx => attestAudit(tx, ctx, other, { through_seq: 0, xhash: "ignored" }, "test-key", true))).toMatchObject({ error: { code: "not_authorized" } });
  } finally { f.store.close(); }
});
