import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { expect, test } from "vitest";
import { canonicalKey, eventHash, GENESIS_PREV_HASH, jcs, overlaps, sign, verify, validateEvent } from "../src/schema/index.js";
import type { Ask, BranchStatus, Decision, Event, GateInput } from "../src/schema/index.js";
import { createSpace, evaluateGate, migrate } from "../src/core/index.js";
import { openStore } from "../src/store-sqlite/index.js";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../test-vectors/2.0/${name}.json`, import.meta.url), "utf8"));
test("portable 2.0 canonical JSON, event chain, resource and signature vectors reproduce", () => {
  const canonical = read<{ input_json: string; jcs: string }[]>("canonical-json");
  for (const v of canonical) expect(jcs(JSON.parse(v.input_json))).toBe(v.jcs);
  // Hand checks: UTF-16 key order; ECMAScript -0 = 0 and 1e21 uses exponent notation.
  expect(canonical[0].jcs).toBe('{"a":"é","z":"é😀"}');
  expect(canonical[1].jcs).toBe('{"decimal":0.1,"large":1e+21,"negative_zero":0,"small":1e-7}');
  const events = read<{ input: Omit<Event, "hash">; hash: string }[]>("event-hash");
  let prev = GENESIS_PREV_HASH;
  for (const v of events) {
    expect(v.input.prev_hash).toBe(prev);
    expect(validateEvent({ ...v.input, hash: v.hash })).toBe(true);
    expect(eventHash(prev, v.input)).toBe(v.hash);
    // Independent recursive serializer for these ASCII-only envelopes, retaining prev_hash twice.
    const canonicalAscii = (x: unknown): string => x && typeof x === "object" ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonicalAscii((x as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(x);
    expect("sha256:" + createHash("sha256").update(prev + canonicalAscii(v.input)).digest("hex")).toBe(v.hash);
    prev = v.hash;
  }
  const resources = read<{ canonical: { input: string; output: string }[]; overlap: { a: string; b: string; output: boolean }[] }>("resource-keys");
  for (const v of resources.canonical) {
    if (v.output === "invalid_resource") expect(() => canonicalKey(v.input)).toThrow("invalid_resource");
    else expect(canonicalKey(v.input)).toBe(v.output);
  }
  for (const v of resources.overlap) expect(overlaps(v.a, v.b)).toBe(v.output);
  // A directory prefix includes its slash: api/ cannot include apix/. ß uppercases to SS.
  expect(resources.overlap.slice(0, 3).map(v => v.output)).toEqual([true, false, true]);
  type Signed = { bytes_utf8: string; bytes_hex: string; signature_base64: string };
  const signatures = read<{ seed_hex: string; public_key_raw_hex: string; hello: Signed & { nonce: string }; deploy_ticket: Signed & { payload: unknown } }>("signatures");
  const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + signatures.seed_hex, "hex"), format: "der", type: "pkcs8" });
  const pub = createPublicKey(key);
  expect(pub.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")).toBe(signatures.public_key_raw_hex);
  expect(signatures.hello.bytes_utf8).toBe("crosstalk-hello:" + signatures.hello.nonce);
  expect(signatures.deploy_ticket.bytes_utf8).toBe(jcs(signatures.deploy_ticket.payload));
  for (const v of [signatures.hello, signatures.deploy_ticket]) {
    expect(Buffer.from(v.bytes_utf8).toString("hex")).toBe(v.bytes_hex);
    expect(sign(v.bytes_utf8, key).toString("base64")).toBe(v.signature_base64);
    expect(verify(v.bytes_utf8, Buffer.from(v.signature_base64, "base64"), pub)).toBe(true);
  }
  // Independent RFC 8032 test #1 anchors the seed/key/signing convention.
  expect(sign("", key).toString("hex")).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
});

test("portable merge-gate snapshots reproduce through real SQLite", () => {
  const vectors = read<{ cases: { name: string; snapshot: { branch_status: BranchStatus | null; asks: Ask[]; decisions: Decision[]; policy: unknown }; input: GateInput; verdict: string }[] }>("merge-gate");
  for (const v of vectors.cases) {
    const store = openStore(":memory:");
    try {
      const actual = store.tx(tx => {
        migrate(tx); createSpace(tx, { now: () => 0, uuid: () => "00000000-0000-4000-8000-000000000099", epoch: "00000000-0000-4000-8000-000000000002" }, v.input.space);
        const { branch_status, asks, decisions, policy } = v.snapshot;
        if (branch_status) tx.run("INSERT INTO branch_status VALUES (?, ?, ?)", v.input.space, branch_status.branch, JSON.stringify(branch_status));
        tx.run("INSERT INTO policies VALUES (?, ?)", v.input.space, JSON.stringify(policy));
        for (const ask of asks) tx.run("INSERT INTO asks(space, ask_id, asker, body) VALUES (?, ?, ?, ?)", v.input.space, ask.ask_id, "human:test", JSON.stringify(ask));
        decisions.forEach((d, i) => tx.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", v.input.space, d.decision_id, i + 1, JSON.stringify(d)));
        return evaluateGate(tx, v.input).verdict;
      });
      expect(actual, v.name).toBe(v.verdict);
    } finally { store.close(); }
  }
  // Requirement precedence: an override admits a draft but cannot lift an open requirement.
  expect(vectors.cases.filter(v => v.name.startsWith("override")).map(v => v.verdict)).toEqual(["pass", "block"]);
});
