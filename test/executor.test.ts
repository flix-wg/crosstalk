import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash, createPublicKey } from "node:crypto";
import { startRelay } from "../src/relay/index.js";
import { trust, RelayClient, credentialScope } from "../src/client/index.js";
import type { SignedTicket } from "../src/schema/index.js";
import { promptMatcher } from "./prompts.js";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xt-executor-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const space = randomUUID(), humanKey = "h".repeat(40), agentKey = "a".repeat(40), ciKey = "c".repeat(40);
  const relay = await startRelay({ database: join(root, "db"), signingKeyFile: join(root, "key"), rateLimit: { burst: 1000, perSecond: 1000 }, bootstrap: { space, principal: "human:test", humanKey, agentKey } }); cleanup.push(relay.close);
  execFileSync("git", ["init", root], { stdio: "ignore" });
  const pin = "sha256:" + createHash("sha256").update(createPublicKey(readFileSync(join(root, "key"))).export({ type: "spki", format: "der" })).digest("hex");
  const conf = `space="${space}"\nrelay="${relay.url}"\nrelay_key="${pin}"\n`;
  writeFileSync(join(root, ".crosstalk.toml"), conf); const config = trust(root), scope = credentialScope(config);
  const human = new RelayClient(config, { token: humanKey });
  const code = "invite".repeat(10);
  await human.request("/invitations", { request_id: randomUUID(), principal: "ci:executor", role: "ci", code_hash: createHash("sha256").update(code).digest("hex") });
  expect((await fetch(relay.url + "/v1/spaces/" + space + "/enroll", { method: "POST", headers: { authorization: "Bearer " + code, "content-type": "application/json" }, body: JSON.stringify({ agentKey: ciKey, humanKey: "unused".repeat(8) }) })).ok).toBe(true);
  await human.send("env.adopt", { env: "prod", sha: "a".repeat(40), artifact: "sha256:" + "0".repeat(64) });
  const enrollment = await human.send("executor.enroll", { env: "prod", executor: "ci:executor", max_fence: 0 });
  mkdirSync(join(root, ".config/crosstalk"), { recursive: true });
  writeFileSync(join(root, ".config/crosstalk/human-credentials.json"), JSON.stringify({ [scope]: humanKey }), { mode: 0o600 });
  const keyFile = join(root, "ci.json"); writeFileSync(keyFile, JSON.stringify({ principal: "ci:executor", [scope]: ciKey }), { mode: 0o600 });
  const promote = join(root, "promote"), live = join(root, "live");
  writeFileSync(promote, `#!/bin/sh\necho run >> '${root}/runs'\nln -sfn "releases/$1" '${root}/current'\n`, { mode: 0o700 });
  writeFileSync(live, `#!/bin/sh\nbasename "$(readlink '${root}/current')"\n`, { mode: 0o700 });
  writeFileSync(join(root, "prod.toml"), conf + `ci_key="${keyFile}"\npromote="${promote}"\nlive="${live}"\ntimeout_s=3\n`, { mode: 0o600 });
  const dir = join(root, "state/prod"); mkdirSync(dir, { recursive: true });
  // Fixture starts from a completed human enrollment, before invoking the real flock entry point.
  writeFileSync(join(dir, "state.json"), JSON.stringify({ epoch: enrollment.epoch, max_fence: 0, installed: null, exec_seq: 0, needs_reconcile: false }));
  const run = (...args: string[]) => new Promise<{ code: number; output: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ["dist/cli/main.js", "executor", ...args], { cwd: process.cwd(), env: { ...process.env, HOME: root, CROSSTALK_EXECUTOR_CONFIG_DIR: root, CROSSTALK_EXECUTOR_STATE_DIR: join(root, "state") }, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
    p.stdout.on("data", b => { output += String(b); }); p.stderr.on("data", b => { output += String(b); }); p.once("error", reject); p.once("close", code => resolve({ code: code ?? 1, output }));
  });
  const agent = new RelayClient(config, { token: agentKey });
  const opened = await agent.request<{ token: string }>("/sessions", { tool: "cli", harness_session_id: "test", machine: "test", worktree: root, branch: null, head: null });
  const session = new RelayClient(config, { token: opened.result.token });
  const claim = async () => (await session.send("lease.claim", { resources: ["env:prod"] })).result as { lease_id: string; fence: number };
  const install = (l: { lease_id: string; fence: number }) => run("install", "prod", "--lease", l.lease_id, "--fence", String(l.fence));
  const ticket = async (l: { lease_id: string; fence: number }, artifact: string) => (await session.request<SignedTicket>("/deploy/ticket", { env: "prod", sha: "a".repeat(40), artifact, lease_id: l.lease_id, fence: l.fence, op: randomUUID() })).result;
  const promoteTicket = async (t: SignedTicket) => { const file = join(root, t.payload.op + ".json"); writeFileSync(file, JSON.stringify(t)); return run("promote", "prod", "--ticket", file); };
  return { root, dir, run, claim, install, ticket, promoteTicket, session, promote, live, config, human, ciKey };
}
test("executor fences stale tickets, records observed artifacts and retries operations exactly once", { timeout: 120000 }, async () => {
  const { root, run, claim, install, ticket, promoteTicket, session, promote, live, config, ciKey, dir } = await fixture();
  expect((await run("enroll", "prod")).output).toContain("tty_required");
  const enrollment = await tty(root, ["enroll", "prod"]); expect(enrollment.code, enrollment.output).toBe(0);
  const a = await claim(); expect(await install(a)).toEqual({ code: 0, output: expect.any(String) }); const ta = await ticket(a, "sha256:" + "a".repeat(64));
  await session.send("lease.release", { lease_id: a.lease_id });
  const b = await claim(); expect(await install(b)).toEqual({ code: 0, output: expect.any(String) }); const tb = await ticket(b, "sha256:" + "b".repeat(64));
  const first = await promoteTicket(tb); expect(first.code, first.output).toBe(0);
  expect((await promoteTicket(ta)).output).toContain("stale_fence");
  expect(await promoteTicket(tb)).toMatchObject({ code: 0 }); expect(readFileSync(join(root, "runs"), "utf8")).toBe("run\n");
  expect((await promoteTicket({ ...tb, payload: { ...tb.payload, artifact: ta.payload.artifact } })).output).toContain("idempotency_mismatch");
  writeFileSync(promote, `#!/bin/sh\necho run >> '${root}/runs'\nexit 0\n`);
  const wrong = await ticket(b, "sha256:" + "c".repeat(64)), result = await promoteTicket(wrong); expect(result.code, result.output).toBe(1); expect(result.output).toContain('"outcome":"failed"');
  expect(result.output).toContain(tb.payload.artifact);
  const old = JSON.parse(readFileSync(join(dir, "ops", tb.payload.op + ".json"), "utf8"));
  const { env, op, sha, artifact, fence, exec_seq, live_after, outcome } = old;
  await new RelayClient(config, { token: ciKey }).request("/deploy/report", { env, op, sha, artifact, fence, exec_seq, live_after, outcome });
  const board = await session.request<{ live: { prod: { live_artifact: string; exec_seq: number } }; deployments: { outcome: string }[] }>("/board"); expect(board.result.deployments.map(d => d.outcome).sort()).toEqual(["adopted", "failed", "promoted"]);
  expect(board.result.live.prod).toMatchObject({ live_artifact: tb.payload.artifact, exec_seq: 2 });
  writeFileSync(live, "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
  const unknown = await promoteTicket(await ticket(b, ta.payload.artifact)); expect(unknown.code).toBe(1); expect(unknown.output).toContain('"live_after":null');
  expect((await install(b)).output).toContain("needs_reconcile");
  writeFileSync(live, `#!/bin/sh\nbasename "$(readlink '${root}/current')"\n`);
  const recovered = await tty(root, ["reconcile", "prod"]); expect(recovered.code, recovered.output).toBe(0);
  expect((await install(b)).code).toBe(0);
});

const waitFor = async (predicate: () => boolean) => { const until = Date.now() + 15000; while (!predicate()) { if (Date.now() > until) throw new Error("Timed out waiting for child boundary"); await new Promise(r => setTimeout(r, 20)); } };
test("executor crash boundaries preserve sequence allocation and require reconciliation", { timeout: 90000 }, async () => {
  const f = await fixture(), lease = await f.claim(); expect((await f.install(lease)).code).toBe(0);
  const t = await f.ticket(lease, "sha256:" + "a".repeat(64)), ticketFile = join(f.root, "ticket.json"); writeFileSync(ticketFile, JSON.stringify(t));
  const preload = join(f.root, "crash.cjs");
  // Fault injection at the durable-write boundary, after the directory fsync.
  writeFileSync(preload, `const fs=require('fs'),{syncBuiltinESMExports}=require('module');let last='';const rename=fs.renameSync,sync=fs.fsyncSync;fs.renameSync=(a,b)=>{rename(a,b);last=b};fs.fsyncSync=(fd)=>{sync(fd);if(last.endsWith(process.env.CRASH_FILE)){const p=last;last='';if(!p.endsWith('state.json')||JSON.parse(fs.readFileSync(p)).exec_seq>0)process.kill(process.pid,'SIGKILL')}};syncBuiltinESMExports();`);
  const crash = (file: string) => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ["dist/cli/main.js", "executor", "promote", "prod", "--ticket", ticketFile], { env: { ...process.env, NODE_OPTIONS: "--require=" + preload, CRASH_FILE: file, CROSSTALK_EXECUTOR_CONFIG_DIR: f.root, CROSSTALK_EXECUTOR_STATE_DIR: join(f.root, "state") }, stdio: "ignore" }); p.once("error", reject); p.once("exit", () => resolve());
  });
  await crash("state.json"); expect(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).exec_seq).toBe(1);
  await crash(t.payload.op + ".json");
  const opFile = join(f.dir, "ops", t.payload.op + ".json");
  expect(JSON.parse(readFileSync(opFile, "utf8"))).toMatchObject({ outcome: "started", exec_seq: 2 });
  expect((await f.promoteTicket(t)).output).toContain("needs_reconcile");
  writeFileSync(f.live, "#!/bin/sh\nprintf '%s\\n' '" + t.payload.artifact + "'\n");
  const reconciled = await tty(f.root, ["reconcile", "prod"]); expect(reconciled.code, reconciled.output).toBe(0);
  expect(JSON.parse(readFileSync(opFile, "utf8"))).toMatchObject({ outcome: "reconciled", exec_seq: 2, reported: true });
  writeFileSync(f.live, `#!/bin/sh\nbasename "$(readlink '${f.root}/current')"\n`);
  const next = await f.ticket(lease, "sha256:" + "b".repeat(64)); expect((await f.promoteTicket(next)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).exec_seq).toBe(3);
});
function tty(root: string, args: string[]) {
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const p = spawn("script", ["-qec", [process.execPath, "dist/cli/main.js", "executor", ...args].map(quote).join(" "), "/dev/null"], { env: { ...process.env, HOME: root, CROSSTALK_EXECUTOR_CONFIG_DIR: root, CROSSTALK_EXECUTOR_STATE_DIR: join(root, "state") }, stdio: ["pipe", "pipe", "pipe"] }); let output = "";
    const match = promptMatcher(s => p.stdin.write(s));
    p.stdout.on("data", b => { output += String(b); match(b); }); p.stderr.on("data", b => { output += String(b); }); p.once("error", reject); p.once("exit", code => resolve({ code: code ?? 1, output }));
  });
}
test("suspended promote blocks install without writes, reconciliation kills groups, and child retains flock after executor death", { timeout: 120000 }, async () => {
  const f = await fixture(), lease = await f.claim(); expect((await f.install(lease)).code).toBe(0);
  const t = await f.ticket(lease, "sha256:" + "a".repeat(64));
  writeFileSync(f.promote, "#!/bin/sh\nkill -STOP $$\n");
  const running = f.promoteTicket(t);
  const lockFile = join(f.dir, "lock.json"); let lock: { pid: number; child_pgid: number };
  await waitFor(() => { try { lock = JSON.parse(readFileSync(lockFile, "utf8")); return !!lock.child_pgid; } catch { return false; } });
  process.kill(lock!.pid, "SIGSTOP");
  await f.session.send("lease.release", { lease_id: lease.lease_id });
  const successor = await f.claim();
  const before = readFileSync(join(f.dir, "state.json"), "utf8"), opBefore = readFileSync(join(f.dir, "ops", t.payload.op + ".json"), "utf8"), lockBefore = readFileSync(lockFile, "utf8");
  expect((await f.install(successor)).output).toContain("executor_busy");
  expect(readFileSync(join(f.dir, "state.json"), "utf8")).toBe(before); expect(readFileSync(lockFile, "utf8")).toBe(lockBefore); expect(readFileSync(join(f.dir, "ops", t.payload.op + ".json"), "utf8")).toBe(opBefore);
  writeFileSync(f.live, "#!/bin/sh\nprintf '%s\\n' '" + t.payload.artifact + "'\n");
  const reconciled = await tty(f.root, ["reconcile", "prod"]); expect(reconciled.code, reconciled.output).toBe(0); await running;
  expect((await f.install(successor)).code).toBe(0);
  writeFileSync(f.promote, `#!/bin/sh\nln -sfn "releases/$1" '${f.root}/current'\n`);
  expect((await f.promoteTicket(await f.ticket(successor, t.payload.artifact))).code).toBe(0);
  writeFileSync(f.promote, "#!/bin/sh\nsleep 4\n");
  const childRun = f.promoteTicket(await f.ticket(successor, t.payload.artifact));
  await waitFor(() => { lock = JSON.parse(readFileSync(lockFile, "utf8")); return !!lock.child_pgid; });
  process.kill(lock!.pid, "SIGKILL");
  const probe = () => { try { execFileSync("flock", ["-n", join(f.dir, "lock"), "true"], { stdio: "ignore" }); return true; } catch { return false; } };
  expect(probe()).toBe(false); await childRun; await waitFor(probe);
});

test("large multi-chunk promote output succeeds; promote timeout records failure", { timeout: 90000 }, async () => {
  const f = await fixture(), lease = await f.claim(); expect((await f.install(lease)).code).toBe(0);
  writeFileSync(f.promote, `#!/bin/sh
for i in 1 2 3 4 5 6; do head -c 2048 /dev/zero; sleep 0.05; done
ln -sfn "releases/$1" '${f.root}/current'
`);
  const t = await f.ticket(lease, "sha256:" + "a".repeat(64));
  const result = await f.promoteTicket(t); expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('"outcome":"promoted"');
  writeFileSync(f.promote, "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
  const failed = await f.promoteTicket(await f.ticket(lease, "sha256:" + "b".repeat(64)));
  expect(failed.code, failed.output).toBe(1); expect(failed.output).toContain('"outcome":"failed"');
  expect(failed.output).toContain(t.payload.artifact);
});

test("busy locks without metadata report busy; reconciliation ignores stale metadata process groups", { timeout: 90000 }, async () => {
  const f = await fixture(), lease = await f.claim();
  const unrelated = spawn("sleep", ["90"], { detached: true, stdio: "ignore" });
  const holder = spawn("flock", [join(f.dir, "lock"), "sleep", "90"], { detached: true, stdio: "ignore" });
  cleanup.push(() => { for (const p of [holder, unrelated]) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* Exited. */ } } });
  await waitFor(() => { try { execFileSync("flock", ["-n", join(f.dir, "lock"), "true"], { stdio: "ignore" }); return false; } catch { return true; } });
  expect((await f.install(lease)).output).toContain("executor_busy");
  writeFileSync(join(f.dir, "lock.json"), JSON.stringify({ pid: unrelated.pid, pgid: unrelated.pid, child_pgid: unrelated.pid, since: Date.now() }));
  writeFileSync(f.live, "#!/bin/sh\nprintf '%s\\n' 'sha256:" + "a".repeat(64) + "'\n");
  const reconciled = await tty(f.root, ["reconcile", "prod"]); expect(reconciled.code, reconciled.output).toBe(0);
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});
