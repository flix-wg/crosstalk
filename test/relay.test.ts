import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { publishedSchemas, SCHEMA_BASE } from "../src/schema/index.js";
import { relevantBoard } from "../src/client/index.js";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
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
  const base = relay.url + "/v2/spaces/" + space;
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
  const response = await fetch(next.url + "/v2/spaces/" + f.space + "/commands", { method: "POST",
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
    const response = await fetch(relay.url + "/v2/init", { method: "POST", headers: { authorization: "Bearer " + operatorKey, "content-type": "application/json" }, body: JSON.stringify({ ...f.config.bootstrap, ...overrides }) });
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
  const hello = (ip: string) => fetch(relay.url + "/v2/hello", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ nonce: "x".repeat(32) }) });
  expect((await hello("192.0.2.1, 10.0.0.1")).status).toBe(200);
  expect((await hello("192.0.2.1, 10.0.0.2")).status).toBe(200);
  expect((await hello("192.0.2.1, 10.0.0.3")).status).toBe(429);
  expect((await hello("192.0.2.2, 10.0.0.1")).status).toBe(200);
  const call = async (path: string, token: string, body?: unknown) => fetch(relay.url + "/v2/spaces/" + f.space + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
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

test("HTTP discovery and version negotiation preserve strict commands", async () => {
  const f = await fixture();
  const discovery = await fetch(f.relay.url + "/.well-known/crosstalk");
  expect(discovery.headers.get("Crosstalk-Protocol")).toBe("2.0");
  expect(await discovery.json()).toEqual({ protocol: "crosstalk", versions: [{ version: "2.0", base: "/v2" }], deprecated: [], implementation: { name: "crosstalk", version: "0.2.0" } });
  for (const [path, status, code] of [["/v1/spaces/x", 404, "unsupported_version"], ["/v99/hello", 404, "unsupported_version"], ["/missing", 404, "not_found"], ["/v2/spaces/" + f.space + "/board", 401, "unauthenticated"]] as const) {
    const response = await fetch(f.relay.url + path);
    expect(response.status).toBe(status);
    expect(response.headers.get("Crosstalk-Protocol")).toBe("2.0");
    expect((await response.json()).error.code).toBe(code);
  }
  const url = new URL(f.relay.url);
  const raw = await new Promise<string>(resolve => {
    const socket = connect(Number(url.port), url.hostname, () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nX: " + "a".repeat(20000) + "\r\n\r\n"));
    socket.once("data", data => { socket.destroy(); resolve(data.toString()); });
  });
  expect(raw).toMatch(/^HTTP\/1\.1 431 [^]*\r\nCrosstalk-Protocol: 2\.0\r\n/);
  for (const [op, args, code] of [["future.op", null, "unsupported_op"], ["toString", {}, "unsupported_op"], ["executor.reconcile", { env: "prod" }, "unsupported_op"], ["lease.claim", {}, "invalid_request"]] as const) {
    const response = await fetch(f.base + "/commands", { method: "POST", headers: { authorization: "Bearer " + f.humanKey, "content-type": "application/json", "Crosstalk-Protocol": "2.99" }, body: JSON.stringify({ request_id: randomUUID(), op, args }) });
    expect(response.status).toBe(400);
    expect(response.headers.get("Crosstalk-Protocol")).toBe("2.0");
    expect((await response.json()).error.code).toBe(code);
  }
});

test("board, inbox and identity responses match their schemas and surface addressed asks", async () => {
  const f = await fixture(), session = await f.session();
  const send = async (token: string, op: string, args: unknown) => {
    const sent = await f.call("/commands", token, { request_id: randomUUID(), op, args });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    return sent;
  };
  await send(f.humanKey, "policy.set", { sequences: { adr: "docs/adr-(\\d+).md" }, protected_branches: ["main"] });
  await send(session, "lease.claim", { mode: "shared", resources: ["path:docs/a.md"], note: "reviewing" });
  await send(session, "lease.claim", { resources: ["path:src/b.ts"] });
  await send(session, "reserve", { sequence: "seq:adr" });
  await send(session, "branch.set", { branch: "feat", state: "wip", head: "a".repeat(40) });
  await send(session, "message.send", { to: ["all"], context_id: randomUUID(), parts: [{ kind: "text", text: "hi" }] });
  await send(f.humanKey, "principal.invite", { principal: "human:other", role: "member" });
  await send(session, "ask.open", { kind: "question", question: "Other?", to: "human:other" });
  const opened = await send(session, "ask.open", { kind: "question", question: "Ship today?", to: "human:test" });
  const ajv = new Ajv2020({ strictTypes: false, formats: fullFormats });
  ajv.addKeyword("x-crosstalk-version");
  for (const schema of Object.values(publishedSchemas())) ajv.addSchema(schema);
  const get = async (name: string, token = session) => {
    const { data } = await f.call("/" + name, token);
    expect(ajv.validate(SCHEMA_BASE + "v2/" + name + ".json", data), ajv.errorsText()).toBe(true);
    return data.result;
  };
  const board = await get("board"), identity = await get("identity");
  const { data: raw } = await f.call("/inbox", session);
  raw.later = 1; raw.result.later = 1; raw.result.asks[0].later = 1;
  expect(ajv.validate(SCHEMA_BASE + "v2/inbox.json", raw), "unknown members are allowed").toBe(true);
  expect(await get("identity", f.humanKey)).not.toHaveProperty("session");
  expect((await get("inbox")).asks).toEqual([opened.data.result]);
  const view = relevantBoard(board, null, identity.session) as { asks: unknown[] };
  expect(Object.keys(view)[0]).toBe("asks");
  expect(view.asks[0]).toEqual(opened.data.result);
});
