import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, sign, verify } from "../src/schema/index.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { openStore } from "../src/store-sqlite/index.js";
import { migrate, createSpace, bootstrapAdmin, issueCredential, authenticate, openSession, execute, sweep, evaluateGate, install, deployTicket, deployAuthorize, liveState, restore, query } from "../src/core/index.js";
import type { Actor, Ctx, Result, SignedTicket } from "../src/core/index.js";

function value<T>(r: Result): T {
  if ("error" in r) throw new Error(r.error.code);
  return r.result as T;
}
function setup(path = ":memory:") {
  const store = openStore(path);
  let now = 1_000_000;
  const ctx: Ctx = { now: () => now, uuid: randomUUID, epoch: randomUUID() };
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

const head = "a".repeat(40);
test("reservation rounds respect floors, retry receipts and permanent abandoned gaps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xt-reserve-"));
  const f = setup(join(dir, "db")), other = openStore(join(dir, "db"));
  try {
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:admin", "agent"));
    const request_id = randomUUID();
    const first = f.command(a, "reserve", { sequence: "seq:alembic", floor: 9 }, { request_id });
    expect(value(first)).toEqual({ value: 9 });
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([a, b].map(async actor => value<{ value: number }>((actor === a ? f.store : other).tx(tx => execute(tx, f.ctx, actor, { request_id: randomUUID(), op: "reserve", args: { sequence: "seq:alembic" } })))));
      expect(results.map(r => r.value)).toEqual([10 + round * 2, 11 + round * 2]);
    }
    value(f.command(a, "reserve", { sequence: "seq:alembic", abandon: 9 }));
    expect(f.command(a, "reserve", { sequence: "seq:alembic", floor: 9 }, { request_id })).toEqual(first);
    expect(value(f.command(b, "reserve", { sequence: "seq:alembic", floor: 1 }))).toEqual({ value: 30 });
  } finally { other.close(); f.store.close(); rmSync(dir, { recursive: true }); }
}, 60_000);
test("coordination ownership, intent expiry, inbox cursors and remote-only reachability", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:other", role: "member" }));
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:other", "agent"));
    expect(f.command(a, "intent.post", { summary: "work", resources: ["tree:src/"], ttl_s: 1e15 })).toMatchObject({ error: { code: "invalid_request" } });
    const intent = value<{ intent_id: string }>(f.command(a, "intent.post", { summary: "work", resources: ["tree:src/"], ttl_s: 1 }));
    expect(f.command(b, "intent.close", { intent_id: intent.intent_id })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(a, "branch.set", { branch: "work", head, state: "draft" }));
    expect(f.command(b, "branch.set", { branch: "work", head, state: "ready" })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(a, "branch.set", { branch: "work", head, state: "ready", owner: "human:other" }));
    value(f.command(b, "branch.set", { branch: "work", head, state: "wip" }));
    const msg = f.command(a, "message.send", { to: ["human:other"], context_id: randomUUID(), parts: [{ kind: "text", text: "hello" }] });
    value(f.command(b, "inbox.ack", { cursor: msg.seq }));
    expect(value(f.command(b, "inbox.ack", { cursor: 0 }))).toEqual({ cursor: msg.seq });
    expect(f.command(a, "ref.advance", { ref: "main", old: null, new: head, commits: [head] })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(f.admin, "principal.invite", { principal: "ci:runner", role: "ci" }));
    expect(f.command(f.key("ci:runner", "ci"), "ref.advance", { ref: "main", old: null, new: head, commits: [head] })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(f.admin, "principal.invite", { principal: "ci:remote", role: "ci" }));
    value(f.command(f.key("ci:remote", "ci"), "ref.advance", { ref: "main", old: null, new: head, commits: [head] }));
    expect(f.store.tx(tx => tx.all("SELECT * FROM reachability"))).toHaveLength(1);
    expect(f.command(a, "policy.set", {})).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(f.admin, "policy.set", { gates: { merge: { unknown: "block" } } }));
    f.setTime(1_001_000);
    expect(f.store.tx(tx => sweep(tx, f.ctx)).map(e => e.body.type)).toContain("intent");
  } finally { f.store.close(); }
});
test("asks enforce addressed human CAS and atomically record bound decisions", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:other", role: "member" }));
    const agent = f.session(f.key("human:admin", "agent")), other = f.key("human:other", "human");
    const ask = value<{ ask_id: string }>(f.command(agent, "ask.open", { kind: "approval", to: "human:admin", question: "Ship?", blocks: ["merge:branch:work"], bound_head: head }));
    for (const actor of [agent, other]) expect(f.command(actor, "ask.answer", { ask_id: ask.ask_id, choice: "approve" }, { expect_rev: 1 })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(f.admin, "ask.answer", { ask_id: ask.ask_id, choice: "approve" }, { expect_rev: 1 }));
    expect(f.command(f.admin, "ask.answer", { ask_id: ask.ask_id, choice: "reject" }, { expect_rev: 1 })).toMatchObject({ error: { code: "stale_revision" } });
    value(f.command(f.admin, "ask.answer", { ask_id: ask.ask_id, choice: "approve", reaffirm: true, bound_head: "b".repeat(40) }, { expect_rev: 2 }));
    const decisions = f.store.tx(tx => tx.all<{ body: string }>("SELECT body FROM decisions ORDER BY seq").map(row => JSON.parse(row.body)));
    expect(decisions).toMatchObject([{ source: { id: ask.ask_id }, bound_head: head, scope: ["merge:branch:work"] }, { source: { id: ask.ask_id }, bound_head: "b".repeat(40) }]);
    const ungated = value<{ ask_id: string }>(f.command(agent, "ask.open", { kind: "approval", to: "human:admin", question: "OK?" }));
    value(f.command(f.admin, "ask.answer", { ask_id: ungated.ask_id, choice: "approve" }, { expect_rev: 1 }));
    const last = f.store.tx(tx => tx.get<{ body: string }>("SELECT body FROM decisions ORDER BY seq DESC LIMIT 1"))!;
    expect(JSON.parse(last.body)).not.toHaveProperty("scope");
    const question = value<{ ask_id: string }>(f.command(agent, "ask.open", { kind: "question", to: "human:admin", question: "Which?", options: ["reject"] }));
    expect(value(f.command(f.admin, "ask.answer", { ask_id: question.ask_id, choice: "reject" }, { expect_rev: 1 }))).toMatchObject({ state: "answered" });
    expect(f.store.tx(tx => tx.all("SELECT * FROM decisions"))).toHaveLength(3);
  } finally { f.store.close(); }
});
const nextHead = "b".repeat(40), artifact = "sha256:" + "a".repeat(64), nextArtifact = "sha256:" + "b".repeat(64);
const mergeInput = { kind: "merge" as const, source_branch: "work", source_head: head, target_branch: "main" };
test("merge gate table applies status policy and head-bound overrides without mutating the snapshot", () => {
  const f = setup();
  try {
    const gate = (extra = {}) => f.store.tx(tx => evaluateGate(tx, { ...mergeInput, space: f.space, now: f.ctx.now(), ...extra }));
    expect(gate().verdict).toBe("warn");
    expect(JSON.stringify(gate())).toContain("publish branch_status ready at the exact head");
    expect(JSON.stringify(gate())).toContain("a merge or new commit changes the head");
    for (const [state, bound, verdict] of [["draft", head, "block"], ["wip", nextHead, "block"], ["ready", head, "pass"], ["ready", nextHead, "warn"]]) {
      value(f.command(f.admin, "branch.set", { branch: "work", state, head: bound }));
      expect(gate().verdict).toBe(verdict);
    }
    value(f.command(f.admin, "branch.set", { branch: "work", state: "draft", head }));
    value(f.command(f.admin, "override.record", { scope: ["merge:branch:work"], bound_head: head, reason: "reviewed" }));
    expect(gate().verdict).toBe("pass");
    expect(gate({ source_head: nextHead }).verdict).toBe("block");
    expect(gate({ unknown_source: true }).verdict).toBe("block");
    expect(f.store.tx(tx => evaluateGate(tx, { kind: "merge", space: f.space, now: f.ctx.now(), source_head: head, target_branch: "main", unknown_source: true })).verdict).toBe("block");
    value(f.command(f.admin, "override.record", { scope: ["merge:target:main"], bound_head: head, reason: "reviewed push" }));
    expect(gate({ unknown_source: true }).verdict).toBe("pass");
    expect(gate({ unknown_source: true, source_head: nextHead }).verdict).toBe("block");
    const before = f.store.tx(tx => tx.get("SELECT seq FROM spaces WHERE space=?", f.space));
    gate(); gate();
    expect(f.store.tx(tx => tx.get("SELECT seq FROM spaces WHERE space=?", f.space))).toEqual(before);
  } finally { f.store.close(); }
});
test("two humans remain independent requirements; reject, cancel and expiry block until withdrawn", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:other", role: "member" }));
    const other = f.key("human:other", "human");
    value(f.command(f.admin, "branch.set", { branch: "work", state: "ready", head }));
    const open = (to: string, extra = {}) => value<{ ask_id: string }>(f.command(f.admin, "ask.open", { kind: "approval", to, question: "Ship?", blocks: ["merge:branch:work"], bound_head: head, ...extra }));
    const gate = () => f.store.tx(tx => evaluateGate(tx, { ...mergeInput, space: f.space, now: f.ctx.now() }));
    const a = open("human:admin"), b = open("human:other");
    value(f.command(f.admin, "ask.answer", { ask_id: a.ask_id, choice: "approve" }, { expect_rev: 1 }));
    expect(gate()).toMatchObject({ verdict: "block", contacts: ["human:other"] });
    value(f.command(other, "ask.answer", { ask_id: b.ask_id, choice: "approve" }, { expect_rev: 1 }));
    expect(gate().verdict).toBe("pass");
    for (const mode of ["reject", "cancel", "expire"]) {
      const ask = open("human:other", { deadline: new Date(f.ctx.now() + 1000).toISOString() });
      if (mode === "expire") {
        f.setTime(f.ctx.now() + 1000);
        expect(gate().verdict).toBe("block");
        f.store.tx(tx => sweep(tx, f.ctx));
      } else value(f.command(mode === "reject" ? other : f.admin, mode === "reject" ? "ask.answer" : "ask.cancel", { ask_id: ask.ask_id, ...(mode === "reject" ? { choice: "reject" } : {}) }, { expect_rev: 1 }));
      value(f.command(f.admin, "override.record", { scope: ["merge:branch:work"], bound_head: head, reason: "cannot bypass ask" }));
      expect(gate().verdict).toBe("block");
      value(f.command(other, "ask.withdraw", { ask_id: ask.ask_id }, { expect_rev: 2 }));
      expect(gate().verdict).toBe("pass");
    }
  } finally { f.store.close(); }
});
function deploySetup() {
  const f = setup();
  const keys = generateKeyPairSync("ed25519");
  f.ctx.signer = { algorithm: "Ed25519", sign: payload => sign(payload, keys.privateKey).toString("base64"), verify: (payload, signature) => verify(payload, Buffer.from(signature, "base64"), keys.publicKey) };
  value(f.command(f.admin, "principal.invite", { principal: "ci:exec-prod", role: "ci" }));
  const executor = f.key("ci:exec-prod", "ci"), holder = f.session(f.key("human:admin", "agent"));
  value(f.command(f.admin, "executor.enroll", { env: "prod", executor: "ci:exec-prod", max_fence: 50 }));
  const lease = value<{ lease_id: string; fence: number }>(f.command(holder, "lease.claim", { resources: ["env:prod"] }));
  const input = { env: "prod", sha: head, artifact, ...lease, op: randomUUID() };
  // Lease responses include presentation fields; wire inputs contain only specified fields.
  const deploy = { env: input.env, sha: input.sha, artifact: input.artifact, lease_id: lease.lease_id, fence: lease.fence, op: input.op };
  const installLease = () => value(f.store.tx(tx => install(tx, f.ctx, executor, { epoch: f.ctx.epoch, env: "prod", lease_id: lease.lease_id, fence: lease.fence, max_fence: 50, dry_run: false })));
  const gate = (extra = {}) => f.store.tx(tx => evaluateGate(tx, { kind: "deploy", space: f.space, now: f.ctx.now(), env: "prod", sha: head, artifact, lease_id: lease.lease_id, fence: lease.fence, holder: holder.session!, ...extra }));
  return { ...f, executor, holder, lease, deploy, installLease, gate, publicKey: keys.publicKey };
}
test("deploy gate table checks installed lease, exact approval, reachability, adoption and freeze", () => {
  const f = deploySetup();
  try {
    expect(f.lease.fence).toBe(52);
    expect(f.gate().verdict).toBe("block");
    f.installLease();
    expect(f.gate({ fence: f.lease.fence + 1 }).verdict).toBe("block");
    expect(f.gate({ holder: randomUUID() }).verdict).toBe("block");
    expect(f.gate().reasons).toEqual(["Environment needs human adoption"]);
    value(f.command(f.admin, "env.adopt", { env: "prod", sha: head, artifact }));
    const ask = value<{ ask_id: string }>(f.command(f.holder, "ask.open", { kind: "approval", to: "human:admin", question: "Deploy?", blocks: ["deploy:env:prod"], bound_head: head, bound_artifact: artifact }));
    expect(f.gate().verdict).toBe("block");
    value(f.command(f.admin, "ask.answer", { ask_id: ask.ask_id, choice: "approve" }, { expect_rev: 1 }));
    expect(f.gate({ artifact: nextArtifact }).verdict).toBe("block");
    expect(f.gate({ sha: nextHead }).verdict).toBe("block");
    expect(f.gate().verdict).toBe("pass");
    value(f.command(f.admin, "policy.set", { envs: { prod: { require_on: "main" } } }));
    expect(f.gate().verdict).toBe("block");
    value(f.command(f.admin, "ref.seed", { ref: "refs/heads/main", commits: [head] }));
    expect(f.gate().verdict).toBe("pass");
    value(f.command(f.admin, "space.freeze", {}));
    expect(f.gate()).toMatchObject({ verdict: "block", code: "frozen" });
    expect(f.command(f.holder, "reserve", { sequence: "seq:build" })).toMatchObject({ error: { code: "frozen" } });
  } finally { f.store.close(); }
});
test("tickets and 30-second authorizations are signed, holder-bound, epoch-bound and re-evaluate gates", () => {
  const f = deploySetup();
  try {
    f.installLease();
    value(f.command(f.admin, "env.adopt", { env: "prod", sha: head, artifact }));
    const other = f.session(f.key("human:admin", "agent"));
    expect(f.store.tx(tx => deployTicket(tx, f.ctx, other, f.deploy))).toMatchObject({ error: { code: "not_authorized" } });
    const ticket = value<SignedTicket>(f.store.tx(tx => deployTicket(tx, f.ctx, f.holder, f.deploy)));
    expect(ticket.payload.expires_at).toBe(f.ctx.now() + 600_000);
    expect(verify(jcs(ticket.payload), Buffer.from(ticket.signature, "base64"), f.publicKey)).toBe(true);
    const authorize = (input = ticket, actor = f.executor) => f.store.tx(tx => deployAuthorize(tx, f.ctx, actor, input));
    expect(authorize(ticket, f.holder)).toMatchObject({ error: { code: "not_authorized" } });
    expect(authorize({ ...ticket, payload: { ...ticket.payload, artifact: nextArtifact } })).toMatchObject({ error: { code: "not_authorized" } });
    const auth = value<{ payload: { exec_allowed_until: number }; signature: string }>(authorize());
    expect(auth.payload).toMatchObject({ ...f.deploy, holder: f.holder.session, exec_allowed_until: f.ctx.now() + 30_000 });
    expect(verify(jcs(auth.payload), Buffer.from(auth.signature, "base64"), f.publicKey)).toBe(true);
    value(f.command(f.holder, "ask.open", { kind: "approval", to: "human:admin", question: "Wait", blocks: ["deploy:env:prod"], bound_head: head, bound_artifact: artifact }));
    expect(authorize()).toMatchObject({ error: { code: "conflict" } });
    value(f.command(f.admin, "space.freeze", {}));
    expect(authorize()).toMatchObject({ error: { code: "frozen" } });
    value(f.command(f.admin, "space.unfreeze", {}));
    f.setTime(ticket.payload.expires_at);
    expect(authorize()).toMatchObject({ error: { code: "not_authorized" } });
  } finally { f.store.close(); }
});
test("reports dedupe by op and derive live state by exec_seq, including late reports and failed promote SHA lookup", () => {
  const f = deploySetup();
  try {
    const report = (exec_seq: number, sha: string, digest: string, live_after: string | null, outcome = "promoted", op = randomUUID()) => ({ env: "prod", sha, artifact: digest, fence: f.lease.fence, op, exec_seq, live_after, outcome });
    const a = report(1, head, artifact, artifact), b = report(2, nextHead, nextArtifact, nextArtifact);
    value(f.command(f.executor, "deployment.record", b));
    value(f.command(f.executor, "deployment.record", a));
    const live = () => f.store.tx(tx => liveState(tx, f.space, "prod"));
    expect(live()).toEqual({ live_artifact: nextArtifact, live_sha: nextHead, exec_seq: 2 });
    value(f.command(f.executor, "deployment.record", a));
    expect(f.command(f.executor, "deployment.record", { ...a, live_after: null, outcome: "failed" })).toMatchObject({ error: { code: "idempotency_mismatch" } });
    value(f.command(f.executor, "deployment.record", report(3, "c".repeat(40), "sha256:" + "c".repeat(64), nextArtifact, "failed")));
    expect(live()).toEqual({ live_artifact: nextArtifact, live_sha: nextHead, exec_seq: 3 });
    expect(value<{ history: unknown[] }>(f.store.tx(tx => query(tx, { kind: "deployments", space: f.space, env: "prod" }))).history).toHaveLength(3);
    value(f.command(f.executor, "deployment.record", report(4, head, artifact, null, "reconciled")));
    expect(live()).toEqual({ live_artifact: null, live_sha: null, exec_seq: 4 });
  } finally { f.store.close(); }
});
test("restore revokes held and pending leases, changes epoch and freezes until executors re-enroll", () => {
  const f = deploySetup();
  try {
    value(f.command(f.holder, "lease.claim", { resources: ["path:x"] }));
    const oldEpoch = f.ctx.epoch;
    const result = f.store.tx(tx => restore(tx, f.ctx, f.space));
    expect(result.epoch).not.toBe(oldEpoch);
    f.ctx.epoch = result.epoch;
    expect(f.store.tx(tx => tx.all<{ state: string }>("SELECT state FROM leases").map(row => row.state))).toEqual(["revoked", "revoked"]);
    expect(f.gate()).toMatchObject({ code: "frozen" });
    expect(f.store.tx(tx => evaluateGate(tx, { ...mergeInput, space: f.space, now: f.ctx.now() }))).toMatchObject({ code: "frozen" });
    expect(f.command(f.admin, "space.unfreeze", {})).toMatchObject({ error: { code: "conflict" } });
    value(f.command(f.admin, "executor.enroll", { env: "prod", executor: "ci:exec-prod", max_fence: 200 }));
    value(f.command(f.admin, "space.unfreeze", {}));
    const lease = value<{ fence: number }>(f.command(f.holder, "lease.claim", { resources: ["env:prod"] }));
    expect(lease.fence).toBe(202);
    expect(f.gate().verdict).toBe("block");
  } finally { f.store.close(); }
});

test("executor operations require the env's active binding and a direct CI key", () => {
  const f = deploySetup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "ci:executor", role: "ci" }));
    const unbound = f.key("ci:executor", "ci");
    for (const executor of ["ci:missing", "human:admin"]) {
      expect(f.command(f.admin, "executor.enroll", { env: "prod", executor, max_fence: 0 })).toHaveProperty("error");
    }
    f.installLease();
    value(f.command(f.admin, "env.adopt", { env: "prod", sha: head, artifact }));
    const ticket = value<SignedTicket>(f.store.tx(tx => deployTicket(tx, f.ctx, f.holder, f.deploy)));
    const reportArgs = { env: "prod", sha: head, artifact, fence: f.lease.fence, op: f.deploy.op, exec_seq: 1, live_after: artifact, outcome: "promoted" };
    const calls = (actor: Actor) => [
      f.store.tx(tx => install(tx, f.ctx, actor, { epoch: f.ctx.epoch, env: "prod", lease_id: f.lease.lease_id, fence: f.lease.fence, max_fence: 50, dry_run: false })),
      f.store.tx(tx => deployAuthorize(tx, f.ctx, actor, ticket)),
      f.command(actor, "deployment.record", reportArgs),
    ];
    for (const actor of [unbound, f.session(f.executor, "ci")]) {
      for (const result of calls(actor)) expect(result).toMatchObject({ error: { code: "not_authorized" } });
    }
    for (const epoch of [randomUUID(), f.ctx.epoch]) {
      f.store.tx(tx => tx.run("UPDATE executors SET epoch=?", epoch));
      for (const result of calls(f.executor)) {
        if (epoch === f.ctx.epoch) expect(result).toHaveProperty("result");
        else expect(result).toMatchObject({ error: { code: "not_authorized" } });
      }
    }
    value(f.command(f.admin, "principal.revoke", { principal: f.executor.principal }));
    expect(f.command(f.admin, "executor.enroll", { env: "prod", executor: f.executor.principal, max_fence: 50 })).toMatchObject({ error: { code: "not_authorized" } });
    for (const result of calls(f.executor)) expect(result).toMatchObject({ error: { code: "not_authorized" } });
  } finally { f.store.close(); }
});

test("blocking approvals require a head and deploy artifact before creating a requirement", () => {
  const f = setup();
  try {
    const args = { kind: "approval", to: "human:admin", question: "Ship?" };
    for (const extra of [{ blocks: ["merge:branch:main"] }, { blocks: ["deploy:env:prod"], bound_head: "a".repeat(40) }])
      expect(f.command(f.admin, "ask.open", { ...args, ...extra })).toMatchObject({ error: { code: "invalid_request" } });
    expect(value(f.command(f.admin, "ask.open", { ...args, blocks: ["deploy:env:prod"], bound_head: "a".repeat(40), bound_artifact: "sha256:" + "b".repeat(64) }))).toMatchObject({ state: "open" });
  } finally { f.store.close(); }
});


test("branch names can be reclaimed only after a ready head was merged or the owner revoked", () => {
  const f = setup();
  try {
    value(f.command(f.admin, "principal.invite", { principal: "human:other", role: "member" }));
    const a = f.session(f.key("human:admin", "agent")), b = f.session(f.key("human:other", "agent"));
    value(f.command(f.admin, "policy.set", { protected_branches: ["refs/heads/main"] }));
    value(f.command(b, "branch.set", { branch: "work", head, state: "ready" }));
    expect(f.command(a, "branch.set", { branch: "work", head, state: "draft" })).toMatchObject({ error: { code: "not_authorized", message: expect.stringContaining("human:other") } });
    value(f.command(f.admin, "ref.seed", { ref: "main", commits: [head] }));
    expect(value(f.command(a, "branch.set", { branch: "work", head, state: "draft" }))).toMatchObject({ owner: "human:admin" });
    // Reachability does not make a draft reusable.
    expect(f.command(b, "branch.set", { branch: "work", head, state: "ready" })).toMatchObject({ error: { code: "not_authorized" } });
    value(f.command(b, "branch.set", { branch: "recycled", head, state: "wip" }));
    value(f.command(f.admin, "principal.revoke", { principal: "human:other" }));
    expect(value(f.command(a, "branch.set", { branch: "recycled", head, state: "draft" }))).toMatchObject({ owner: "human:admin" });
  } finally { f.store.close(); }
});
