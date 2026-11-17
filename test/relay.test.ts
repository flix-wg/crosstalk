import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jcs, sha256 } from "../src/schema/index.js";
import { openStore } from "../src/store-sqlite/index.js";
import { startRelay, restoreDatabase } from "../src/relay/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
export async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xt-relay-"));
  const space = randomUUID(), humanKey = "h".repeat(40), agentKey = "a".repeat(40);
  const config = { database: join(dir, "db"), signingKeyFile: join(dir, "key"), bootstrap: { space, principal: "human:test", humanKey, agentKey } };
  const relay = await startRelay(config);
  cleanup.push(async () => { await relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = relay.url + "/v1/spaces/" + space;
  async function call(path: string, token: string, body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const session = async () => (await call("/sessions", agentKey, { tool: "codex", harness_session_id: randomUUID(), machine: "test", worktree: null, branch: null, head: null })).data.result.token as string;
  return { dir, config, relay, base, space, humanKey, agentKey, call, session };
}
test("HTTP sessions arbitrate claims and persist session-scoped receipts", { timeout: 60000 }, async () => {
  const f = await fixture(), a = await f.session(), b = await f.session();
  expect(statSync(f.config.signingKeyFile).mode & 0o777).toBe(0o600);
  const command = { request_id: randomUUID(), op: "lease.claim", args: { resources: ["path:a"] } };
  const claimed = await f.call("/commands", a, command);
  expect(claimed.status).toBe(200);
  expect((await f.call("/commands", b, { ...command, request_id: randomUUID() })).status).toBe(409);
  expect((await f.call("/receipts/" + command.request_id, b)).status).toBe(404);
  expect((await f.call("/commands", b, command)).status).toBe(409);
  expect((await f.call("/receipts/" + command.request_id, a)).data).toEqual({ ...claimed.data, payload_hash: sha256(jcs(command)) });
  expect((await f.call("/commands", a, { request_id: randomUUID(), op: "lease.release", args: { lease_id: claimed.data.result.lease_id } })).status).toBe(200);
});
test("long-poll wakes after commit and times out with no events", { timeout: 60000 }, async () => {
  const f = await fixture(), token = await f.session();
  const board = await f.call("/board", token);
  const pending = f.call("/events?after=" + board.data.seq + "&wait_s=1", token);
  await new Promise(resolve => setTimeout(resolve, 40));
  await f.call("/commands", token, { request_id: randomUUID(), op: "lease.claim", args: { resources: ["path:b"] } });
  const events = await pending;
  expect(events.data.result).toHaveLength(1);
  const started = Date.now();
  const empty = await f.call("/events?after=" + events.data.seq + "&wait_s=0.05", token);
  expect(empty.data.result).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
});
test("HTTP rejects invalid authentication, oversized JSON and frozen gates after restore", { timeout: 60000 }, async () => {
  const f = await fixture(), token = await f.session();
  expect((await f.call("/board", "wrong")).status).toBe(401);
  expect((await f.call("/commands", token, { text: "a".repeat(16384) })).status).toBe(413);
  const before = await f.call("/board", token);
  await f.relay.close();
  restoreDatabase(f.config.database, f.space);
  const next = await startRelay(f.config);
  cleanup.push(next.close);
  const response = await fetch(next.url + "/v1/spaces/" + f.space + "/commands", { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ request_id: randomUUID(), op: "reserve", args: { sequence: "seq:test" } }) });
  const result = await response.json();
  expect(response.status).toBe(423);
  expect(result.epoch).not.toBe(before.data.epoch);
});

test("events require resync when a cursor predates retained history", { timeout: 60000 }, async () => {
  const f = await fixture(), token = await f.session();
  await f.call("/commands", token, { request_id: randomUUID(), op: "lease.claim", args: { resources: ["path:a"] } });
  const store = openStore(f.config.database);
  try {
    store.tx(tx => {
      tx.run("DELETE FROM outbox WHERE space=? AND seq=1", f.space);
      tx.run("DELETE FROM events WHERE space=? AND seq=1", f.space);
    });
  } finally { store.close(); }
  const result = await f.call("/events?after=0&wait_s=1", token);
  expect(result.status).toBe(409);
  expect(result.data.error.code).toBe("resync");
});

test("repeated init requires the exact admin principal and credential kinds", { timeout: 60000 }, async () => {
  const f = await fixture();
  await f.relay.close();
  const operatorKey = "o".repeat(40);
  const relay = await startRelay({ ...f.config, operatorKey }); cleanup.push(relay.close);
  const init = async (overrides: Record<string, unknown> = {}) => {
    const response = await fetch(relay.url + "/v1/init", { method: "POST", headers: { authorization: "Bearer " + operatorKey, "content-type": "application/json" }, body: JSON.stringify({ ...f.config.bootstrap, ...overrides }) });
    return { status: response.status, data: await response.json() };
  };
  expect((await init()).status).toBe(200);
  for (const mismatch of [{ principal: "human:other" }, { humanKey: f.agentKey, agentKey: f.humanKey }, { agentKey: "x".repeat(40) }, { agentKey: f.humanKey }]) {
    expect(await init(mismatch)).toMatchObject({ status: 409, data: { error: { code: "conflict" } } });
  }
  const store = openStore(f.config.database);
  try { store.tx(tx => tx.run("UPDATE principals SET role='member' WHERE space=?", f.space)); } finally { store.close(); }
  expect(await init()).toMatchObject({ status: 409, data: { error: { code: "conflict" } } });
});

test("proxy hello buckets use the first forwarded address; authenticated buckets isolate sessions", { timeout: 60000 }, async () => {
  const f = await fixture(); await f.relay.close();
  const relay = await startRelay({ ...f.config, trustProxy: true, rateLimit: { burst: 2, perSecond: 0.01 } }); cleanup.push(relay.close);
  const hello = (ip: string) => fetch(relay.url + "/v1/hello", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ nonce: "x".repeat(32) }) });
  expect((await hello("192.0.2.1, 10.0.0.1")).status).toBe(200);
  expect((await hello("192.0.2.1, 10.0.0.2")).status).toBe(200);
  expect((await hello("192.0.2.1, 10.0.0.3")).status).toBe(429);
  expect((await hello("192.0.2.2, 10.0.0.1")).status).toBe(200);
  const call = async (path: string, token: string, body?: unknown) => fetch(relay.url + "/v1/spaces/" + f.space + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const tokens: string[] = [];
  for (let i = 0; i < 2; i++) tokens.push((await (await call("/sessions", f.agentKey, { tool: "codex", harness_session_id: String(i), machine: "test", worktree: null, branch: null, head: null })).json()).result.token);
  expect((await call("/board", tokens[0])).status).toBe(200);
  expect((await call("/board", tokens[0])).status).toBe(200);
  expect((await call("/board", tokens[0])).status).toBe(429);
  expect((await call("/board", tokens[1])).status).toBe(200);
});

test("reinvitation does not reactivate outstanding capabilities from before principal revocation", { timeout: 60000 }, async () => {
  const f = await fixture(), code = "old-invitation".repeat(4);
  expect((await f.call("/invitations", f.humanKey, { request_id: randomUUID(), principal: "human:member", role: "member", code_hash: sha256(code).slice(7) })).status).toBe(200);
  expect((await f.call("/commands", f.humanKey, { request_id: randomUUID(), op: "principal.revoke", args: { principal: "human:member" } })).status).toBe(200);
  expect((await f.call("/commands", f.humanKey, { request_id: randomUUID(), op: "principal.invite", args: { principal: "human:member", role: "member" } })).status).toBe(200);
  expect((await f.call("/enroll", code, { agentKey: "x".repeat(40), humanKey: "y".repeat(40) })).status).toBe(403);
});
