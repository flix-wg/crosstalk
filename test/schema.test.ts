import { readdirSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import {
  canonicalKey, commandArgsSchemas, eventHash, GENESIS_PREV_HASH,
  InvalidResourceError, isLeasableKey, jcs, overlaps, PROTOCOL_VERSION, publishedSchemas, SCHEMA_BASE, sign, validateCommand, validateEvent, verify,
} from "../src/schema/index.js";
import type { Ask, CommandArgs, Event } from "../src/schema/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const digest = "sha256:" + "a".repeat(64);
const genesis: Event = JSON.parse(readFileSync(new URL("./fixtures/genesis.json", import.meta.url), "utf8"));
const approval: Ask = {
  type: "ask", ask_id: id, rev: 1, kind: "approval", to: "human:felix",
  question: "Ship this revision?", state: "open", blocks: ["deploy:env:prod"],
  bound_head: "a".repeat(40), bound_artifact: digest,
};

test("genesis validates and matches an independently computed hash regardless of property order", () => {
  expect(validateEvent(genesis), JSON.stringify(validateEvent.errors)).toBe(true);
  expect(genesis.prev_hash).toBe(GENESIS_PREV_HASH);
  expect(eventHash(GENESIS_PREV_HASH, genesis)).toBe(genesis.hash);
  expect(eventHash(GENESIS_PREV_HASH, Object.fromEntries(Object.entries(genesis).reverse()) as Event)).toBe(genesis.hash);
  expect(eventHash(GENESIS_PREV_HASH, { ...genesis, seq: 2 })).not.toBe(genesis.hash);
  expect(() => eventHash(digest, genesis)).toThrow();
});

test("published schemas compile together and match the protocol's schema index", () => {
  const protocol = readFileSync(new URL("../docs/protocol.md", import.meta.url), "utf8");
  const index = protocol.split("## Appendix A")[1].split("## Appendix B")[0];
  const listed = [...index.matchAll(/`(https:\/\/[^`]+\.json)`/g)].map(m => m[1]).sort();
  const published = Object.values(publishedSchemas());
  expect(published.map(s => s.$id).sort()).toEqual(listed);
  const ajv = new Ajv2020({ strictTypes: false, formats: fullFormats });
  ajv.addKeyword("x-crosstalk-version");
  for (const schema of published) ajv.addSchema(schema);
  for (const schemaId of listed) expect(ajv.getSchema(schemaId)).toBeTypeOf("function");
  const deploy = ajv.getSchema(`${SCHEMA_BASE}v2/deploy.json`)!;
  expect(deploy({ env: "prod", sha: "a".repeat(40), artifact: digest, lease_id: id, fence: 1, op: id })).toBe(true);
  const gate = ajv.getSchema(`${SCHEMA_BASE}v2/gate.json`)!;
  expect(gate({ kind: "merge", source_branch: "x", source_head: "a".repeat(40), target_branch: "main" })).toBe(true);
});

test("the committed snapshot of the current protocol version matches the generated schemas", () => {
  const dir = new URL(`../schemas/${PROTOCOL_VERSION}/`, import.meta.url);
  const generated = publishedSchemas();
  expect(readdirSync(dir).sort()).toEqual(Object.keys(generated).map(name => `${name}.json`).sort());
  for (const [name, schema] of Object.entries(generated)) expect(JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"))).toEqual(schema);
});

test("blocking approval ask validates", () => {
  expect(validateEvent({ ...genesis, body: approval }), JSON.stringify(validateEvent.errors)).toBe(true);
});

test("question with blocks fails", () => {
  expect(validateEvent({ ...genesis, body: { ...approval, kind: "question" } })).toBe(false);
});

test("deployment records accept initial adoption at sequence zero and executor attempts", () => {
  const body = {
    type: "deployment", env: "prod", sha: "a".repeat(40), artifact: digest,
    fence: null, op: null, exec_seq: 0, outcome: "adopted", live_after: digest,
  };
  expect(validateEvent({ ...genesis, body })).toBe(true);
  expect(validateEvent({ ...genesis, body: { ...body, fence: 1, op: id, exec_seq: 1, outcome: "promoted" } })).toBe(true);
  expect(validateEvent({ ...genesis, body: { ...body, exec_seq: -1 } })).toBe(false);
});

test("decision without scope validates, while an explicitly empty scope fails", () => {
  const body = {
    type: "decision", decision_id: id, source: { kind: "ask", id },
    verdict: "approve", bound_head: null, decided_by: "human:felix",
  };
  expect(validateEvent({ ...genesis, body })).toBe(true);
  expect(validateEvent({ ...genesis, body: { ...body, scope: [] } })).toBe(false);
});

test("event validation enforces formats and rejects unknown properties", () => {
  for (const change of [{ space: "bad" }, { recorded_at: "2026-02-30T12:00:00Z" }, { unexpected: true }]) {
    expect(validateEvent({ ...genesis, ...change })).toBe(false);
  }
});

test("resource canonicalization and symmetric overlap follow the key table", () => {
  for (const [raw, expected] of [["tree:API", "tree:API/"], ["path:cafe\u0301.ts", "path:café.ts"], ["seq:alembic", "seq:alembic"]]) {
    expect(canonicalKey(raw)).toBe(expected);
    expect(canonicalKey(expected)).toBe(expected);
  }
  for (const raw of ["tree:/", "path:/x", "path:a//b", "path:a/../b", "path:./a", "path:a/", "path:a\\b", "res:x\n", "env:Prod", "seq:a/b", "unknown:x", "path:\ud800", "path:" + "é".repeat(254)]) {
    expect(() => canonicalKey(raw), raw).toThrow(InvalidResourceError);
  }
  expect(Buffer.byteLength(canonicalKey("path:" + "a".repeat(507)))).toBe(512);
  const rows: [string, string, boolean][] = [
    ["path:API/a.ts", "path:api/A.ts", true],
    ["tree:api/", "path:API/a.ts", true],
    ["tree:api/", "tree:api/nested/", true],
    ["tree:api/", "tree:api/", true],
    ["tree:api/", "path:apix/a.ts", false],
    ["tree:api/", "path:api", false],
    ["path:api", "path:api/a.ts", false],
    ["branch:Feature/A", "branch:feature/a", true],
    ["res:Widget", "res:widget", true],
    ["env:prod", "env:prod", true],
    ["env:prod", "env:production", false],
    ["seq:alembic", "seq:alembic", false],
    ["res:prod", "env:prod", false],
  ];
  for (const [a, b, expected] of rows) {
    expect(overlaps(a, b), a + " / " + b).toBe(expected);
    expect(overlaps(b, a)).toBe(expected);
  }
  expect(isLeasableKey("seq:alembic")).toBe(false);
  expect(isLeasableKey("env:prod")).toBe(true);
});

// RFC 8785 sections 3.2.2–3.2.3 and Appendix B:
// https://www.rfc-editor.org/rfc/rfc8785.html
test("JCS uses ECMAScript number encoding and UTF-16 property sorting recursively", () => {
  expect(jcs({ b: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0, 5e-324], a: null }))
    .toBe('{"a":null,"b":[333333333.3333333,1e+30,4.5,0.002,1e-27,0,5e-324]}');
  const keys = ["\u20ac", "\r", "\ufb33", "1", "😀", "\u0080", "ö"];
  expect(jcs(Object.fromEntries(keys.map((key) => [key, 0]))))
    .toBe('{"\\r":0,"1":0,"\u0080":0,"ö":0,"€":0,"😀":0,"דּ":0}');
  expect(jcs({ z: [{ b: true, a: "\u000f\n\"\\/" }], a: "e\u0301" }))
    .toBe('{"a":"e\u0301","z":[{"a":"\\u000f\\n\\"\\\\/","b":true}]}');
});

test("JCS rejects values that cannot be represented as interoperable JSON", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const value of [NaN, Infinity, "\ud800", { "\udfff": 1 }, undefined, 1n, { a: undefined }, Array(1), new Date(), cycle]) {
    expect(() => jcs(value)).toThrow(TypeError);
  }
});

test("Ed25519 signatures roundtrip and reject tampering or wrong keys", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const data = jcs(genesis);
  const signature = sign(data, privateKey);
  expect(verify(data, signature, publicKey)).toBe(true);
  expect(verify(data + " ", signature, publicKey)).toBe(false);
  const altered = Buffer.from(signature);
  altered[0] ^= 1;
  expect(verify(data, altered, publicKey)).toBe(false);
  expect(verify(data, signature, generateKeyPairSync("ed25519").publicKey)).toBe(false);
  expect(() => sign(data, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)).toThrow();
});

test("every command op validates minimal inputs and rejects missing args or unknown ops", () => {
  const examples: CommandArgs = {
    "lease.claim": { resources: ["env:prod"], ttl_s: 600 },
    "lease.release": { lease_id: id },
    "session.release": { session: id },
    reserve: { sequence: "seq:alembic" },
    "message.send": { to: ["all"], context_id: id, parts: [{ kind: "text", text: "Hello" }] },
    "inbox.ack": { cursor: 0 },
    "ask.open": { kind: "approval", to: "human:felix", question: "Ship?", blocks: ["deploy:env:prod"] },
    "branch.set": { branch: "main", state: "ready", head: null },
    "ask.answer": { ask_id: id, choice: "approve" },
    "ask.withdraw": { ask_id: id },
    "override.record": { scope: ["merge:branch:main"], bound_head: null, reason: "Reviewed" },
    "env.adopt": { env: "prod", sha: null, artifact: digest },
    "executor.enroll": { env: "prod", executor: "ci:exec-prod", max_fence: 0 },
    "lease.revoke": { lease_id: id, reason: "Stuck" },
    "principal.invite": { principal: "human:felix", role: "admin" },
    "principal.revoke": { principal: "human:felix" },
    "space.unfreeze": {},
    "policy.set": { gates: { merge: { unknown_source: "block" } } },
    "deployment.record": { env: "prod", sha: "a".repeat(40), artifact: "sha256:" + "a".repeat(64), fence: 1, op: id, exec_seq: 1, live_after: null, outcome: "failed" },
    "space.freeze": {},
    "ref.seed": { ref: "main", commits: ["a".repeat(40)] },
    "ref.advance": { ref: "refs/heads/main", old: null, new: "a".repeat(40), commits: ["a".repeat(40)] },
  };
  expect(Object.keys(examples).sort()).toEqual(Object.keys(commandArgsSchemas).sort());
  for (const [op, args] of Object.entries(examples)) {
    expect(validateCommand({ request_id: id, op, args, ...(["ask.answer", "ask.withdraw"].includes(op) ? { expect_rev: 1 } : {}) }), op + JSON.stringify(validateCommand.errors)).toBe(true);
    expect(validateCommand({ request_id: id, op })).toBe(false);
    expect(validateCommand({ request_id: id, op, args: { ...args, bogus: true } })).toBe(false);
  }
  expect(validateCommand({ request_id: id, op: "unknown", args: {} })).toBe(false);
  expect(validateCommand({ request_id: "bad", op: "space.unfreeze", args: {} })).toBe(false);
});

test("lease inputs reject sequences, mixed env claims and out-of-range TTLs", () => {
  for (const args of [
    { resources: ["seq:alembic"] }, { resources: ["env:prod", "path:a"] },
    { resources: ["path:a"], ttl_s: 29 }, { resources: ["path:a"], ttl_s: 3601 },
  ]) {
    expect(validateCommand({ request_id: id, op: "lease.claim", args })).toBe(false);
  }
});

test("overlap folds Unicode case, including final sigma", () => {
  expect(overlaps("path:ΟΣ", "path:οσ")).toBe(true);
  expect(overlaps("tree:ΟΣ/", "path:οσ/x")).toBe(true);
});
