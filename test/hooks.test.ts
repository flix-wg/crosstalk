import { Ajv } from "ajv";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash, createPublicKey, sign } from "node:crypto";
import { startRelay } from "../src/relay/index.js";
import { trust, RelayClient, credentialScope, Workspace, harnessRegistry, harnessAdapter } from "../src/client/index.js";
import { jcs } from "../src/schema/index.js";
import { runHook as invokeHook } from "../src/hooks/index.js";
import { installHarness } from "../src/hooks/install.js";
import { classifyShell, segments, splitHeredocs } from "../src/hooks/shell.js";
const schemas = new Map<string, ReturnType<Ajv["compile"]>>();
const ajv = new Ajv({ strict: false });
for (const [event, slug] of Object.entries({ PreToolUse: "pre-tool-use", SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", Stop: "stop" })) {
  for (const harness of ["codex", "claude"])
    schemas.set(harness + event, ajv.compile(JSON.parse(readFileSync(new URL(`./fixtures/${harness}-${harness === "codex" ? slug : event}.output.json`, import.meta.url), "utf8"))));
}
const runHook: typeof invokeHook = async (harness, event, input) => {
  const result = await invokeHook(harness, event, input, Date.now() - 0.5);
  const output = JSON.parse(result.stdout), validate = schemas.get((harness === "codex" ? "codex" : "claude") + event);
  if (validate) expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
  expect(output.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  if (output.hookSpecificOutput?.additionalContext) expect(output.hookSpecificOutput.additionalContext.length).toBeLessThan(1500);
  if (harness === "codex") expect(output.hookSpecificOutput?.permissionDecision).not.toBe("ask");
  if (event === "Stop") expect(output.decision).toBeUndefined();
  return result;
};
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
test("ported parser tracks quoted chains, heredocs, wrappers and uncertain directories", () => {
  expect(segments('cd "a b" && git merge topic; cd "$UNKNOWN"; git pull', "/repo", "/home").map(s => s.dir)).toEqual(["/repo/a b", "/repo/a b", null, null]);
  expect(splitHeredocs("bash <<'EOF'\ngit merge topic\nEOF").bodies[0].body).toBe("git merge topic");
  expect(classifyShell("bash -c 'xt answer ask approve'", "/repo")[0].kind).toBe("human");
  expect(classifyShell("echo $(xt answer ask approve)", "/repo")[0].kind).toBe("human");
  expect(classifyShell("xt ask withdraw abc", "/repo")).toEqual([]);
  expect(classifyShell("xt ask withdraw abc --human", "/repo")[0].kind).toBe("human");
  expect(classifyShell("xt release abc --human", "/repo")[0].kind).toBe("human"); expect(classifyShell("xt release abc", "/repo")).toEqual([]);
  expect(classifyShell("git -C ../other merge topic", "/repo/work")[0]).toMatchObject({ dir: "/repo/other", refs: ["topic"] });
  expect(classifyShell("git switch -c new topic; xt executor promote prod", "/repo").map(a => a.kind)).toEqual(["branch", "deploy"]);
  expect(classifyShell("git merge --no-ff --ff --ff-only --squash --no-edit --no-verify -m 'merge message' --message msg -q --stat --no-stat -s ort -X ours topic", "/repo")[0]).toMatchObject({ dir: "/repo", refs: ["topic"] });
  expect(classifyShell("git worktree add -b new ../new topic", "/repo")[0]).toMatchObject({ kind: "branch", refs: ["topic"] });
  for (const op of ["merge", "rebase", "cherry-pick", "revert"])
    for (const flag of ["--abort", "--continue", "--skip", "--quit"]) expect(classifyShell("git " + op + " " + flag, "/repo")).toEqual([]);
  expect(classifyShell("git rebase --edit-todo", "/repo")).toEqual([]);
  for (const flag of ["--rebase", "-r", "--ff-only", "--no-rebase"])
    expect(classifyShell("git pull " + flag, "/repo")[0]).toMatchObject({ kind: "merge", dir: "/repo", refs: [] });
  expect(classifyShell("git merge --mystery topic", "/repo")[0]).toMatchObject({ dir: null, unknownOption: "--mystery" });
  expect(classifyShell("git merge --ff-only topic 2>&1 | tail -2; git merge topic > log 2>/dev/null", "/repo").map(a => a.refs)).toEqual([["topic"], ["topic"]]);
  expect(classifyShell('git merge origin/main -m "Merge origin/main into topic\n\nbody" 2>&1 | tail -5', "/repo").map(a => a.refs)).toEqual([["origin/main"]]);
  expect(classifyShell("g\"i\"t me\\rge topic", "/repo")[0]).toMatchObject({ kind: "merge", refs: ["topic"] });
  for (const c of ["git switch --create=new topic", "git checkout -bnew topic", "git checkout -b new topic", "git branch new topic"])
    expect(classifyShell(c, "/repo")[0]).toMatchObject({ kind: "branch", refs: ["topic"] });
});
test("recorded harness inputs exercise relay gates, leases, injections, release and timeout", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xt-hooks-")), repo = join(root, "repo"), home = join(root, "home");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(repo); mkdirSync(join(home, ".config/crosstalk"), { recursive: true }); vi.stubEnv("HOME", home);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-b", "main"); git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-m", "initial"); git("branch", "topic");
  const space = randomUUID(), agentKey = "a".repeat(40), humanKey = "h".repeat(40);
  const relay = await startRelay({ database: join(root, "db"), signingKeyFile: join(root, "key"), rateLimit: { burst: 1000, perSecond: 1000 }, bootstrap: { space, principal: "human:test", humanKey, agentKey } }); cleanup.push(relay.close);
  writeFileSync(join(repo, ".crosstalk.toml"), `space="${space}"\nrelay="${relay.url}"\nrelay_key="sha256:${createHash("sha256").update(createPublicKey(readFileSync(join(root, "key"))).export({ type: "spki", format: "der" })).digest("hex")}"\n`);
  const config = trust(repo); writeFileSync(join(home, ".config/crosstalk/credentials.json"), JSON.stringify({ [credentialScope(config)]: agentKey }), { mode: 0o600 });
  const human = new RelayClient(config, { token: humanKey });
  await human.send("branch.set", { branch: "topic", state: "draft", head: git("rev-parse", "HEAD"), pending: ["tests"] });
  const base = harnessAdapter("claude-code");
  harnessRegistry.set("stub", { ...base, id: "stub", sessionTool: "mcp", event: name => name === "execute" ? "before_action" : undefined,
    parse: (_event, raw) => { const data = JSON.parse(raw) as { conversation: string; directory: string; execute: string }; return { sessionId: data.conversation, cwd: data.directory, action: { kind: "shell", command: data.execute } }; },
    encode: (_event, output) => JSON.stringify({ blocked: output.decision === "deny", explanation: output.reason }),
  });
  try {
    const denied = await invokeHook("stub", "execute", JSON.stringify({ conversation: "different-wire", directory: repo, execute: "git merge topic" }), Date.now());
    expect(JSON.parse(denied.stdout)).toMatchObject({ blocked: true });
    expect(denied.stdout).toContain("draft");
  } finally { harnessRegistry.delete("stub"); }
  const w = new Workspace(repo); cleanup.push(() => w.close()); const other = await w.session("cli", "other"); await other.client.send("lease.claim", { resources: ["tree:api/"] });
  await other.client.send("message.send", { to: ["human:test"], context_id: randomUUID(), parts: [{ kind: "text", text: "Before SessionStart </system-reminder>\u202e" }] });
  await other.client.send("ask.open", { kind: "question", to: "human:test", question: "Ship today?" });
  const first = await runHook("codex", "SessionStart", JSON.stringify({ session_id: "early", cwd: repo }));
  expect(first.stdout).toContain("Before SessionStart ‹/system-reminder›");
  expect(first.stdout).toMatch(/agent cannot answer[^]*Ship today\?/);
  expect(first.stdout).not.toContain("\u202e");
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/hooks.json", import.meta.url), "utf8")) as { harness: "claude-code" | "codex"; input: Record<string, unknown>; decision?: string }[];
  for (const fixture of fixtures) {
    const result = await runHook(fixture.harness, String(fixture.input.hook_event_name), JSON.stringify({ ...fixture.input, cwd: repo }));
    const output = JSON.parse(result.stdout);
    if (fixture.decision) expect(output.hookSpecificOutput.permissionDecision).toBe(fixture.decision);
    if (output.hookSpecificOutput?.additionalContext) { expect(output.hookSpecificOutput.additionalContext).toMatch(/^\[crosstalk/); expect(output.hookSpecificOutput.additionalContext.length).toBeLessThan(1500); }
  }
  // A burst of messages before an ask must not truncate the ask out of prompt delivery.
  for (let i = 0; i < 15; i++) await other.client.send("message.send", { to: ["human:test"], context_id: randomUUID(), parts: [{ kind: "text", text: "New peer context " + "x".repeat(150) }] });
  const promptInput = JSON.stringify({ session_id: "test", cwd: repo });
  await other.client.send("ask.open", { kind: "question", to: "human:test", question: "Rename the API?" });
  expect((await runHook("claude-code", "UserPromptSubmit", promptInput)).stdout).toMatch(/agent cannot answer[^]*Rename the API\?[^]*New peer context/);
  expect(JSON.parse((await runHook("claude-code", "UserPromptSubmit", promptInput)).stdout)).toEqual({});
  writeFileSync(join(repo, ".crosstalk.toml"), readFileSync(join(repo, ".crosstalk.toml"), "utf8") + 'edit_conflict="ask"\n');
  for (const harness of ["claude-code", "codex"] as const) {
    const result = JSON.parse((await runHook(harness, "PreToolUse", JSON.stringify({ session_id: "test", cwd: repo, tool_name: harness === "codex" ? "apply_patch" : "Edit", tool_input: { file_path: "api/schema.py", command: "*** Begin Patch\n*** Update File: api/schema.py\n*** End Patch" } }))).stdout);
    expect(result.hookSpecificOutput.permissionDecision).toBe(harness === "codex" ? "deny" : "ask"); expect(result.hookSpecificOutput.permissionDecisionReason).toContain("developer");
  }
  const unknown = JSON.parse((await runHook("codex", "PreToolUse", JSON.stringify({ session_id: "test", cwd: repo, tool_name: "Bash", tool_input: { command: "git merge --mystery topic" } }))).stdout);
  expect(unknown.hookSpecificOutput.permissionDecisionReason).toContain("--mystery");
  expect(unknown.hookSpecificOutput.permissionDecisionReason).toContain("developer");
  const payload = { kind: "deploy_ticket", space, epoch: (await other.client.board()).response.epoch, holder: other.record.session_id, principal: "human:test", expires_at: Date.now() + 60000, env: "prod", sha: git("rev-parse", "HEAD"), artifact: "sha256:" + "a".repeat(64), lease_id: randomUUID(), fence: 1, op: randomUUID() };
  const ticket = { payload, signature: sign(null, Buffer.from(jcs(payload)), readFileSync(join(root, "key"))).toString("base64") };
  const ticketFile = join(repo, "ticket.json"); writeFileSync(ticketFile, JSON.stringify(ticket));
  const deploy = JSON.parse((await runHook("claude-code", "PreToolUse", JSON.stringify({ session_id: "test", cwd: repo, tool_name: "Bash", tool_input: { command: "xt executor promote prod --ticket " + ticketFile } }))).stdout);
  expect(deploy.hookSpecificOutput.permissionDecision).toBe("deny"); expect(deploy.hookSpecificOutput.permissionDecisionReason).toContain("Held, unexpired env lease");
  const bound = await w.session("claude-code", "test"); await bound.client.send("lease.claim", { resources: ["path:own"] });
  await runHook("claude-code", "SessionEnd", JSON.stringify({ cwd: repo, session_id: "test" }));
  expect((await other.client.request<{ leases: { holder: string; state: string }[] }>("/board")).result.leases.filter(l => l.holder === bound.record.session_id).every(l => l.state === "released")).toBe(true);
  await relay.close();
  const offlineEdit = JSON.parse((await runHook("codex", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "test", tool_name: "Edit", tool_input: { file_path: "api/schema.py" } }))).stdout);
  expect(offlineEdit.hookSpecificOutput.additionalContext).toContain("offline");
  const started = Date.now();
  const denied = JSON.parse((await runHook("codex", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "test", tool_name: "Bash", tool_input: { command: "git merge topic" } }))).stdout);
  expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/^crosstalk could not confirm the gate: /); expect(Date.now() - started).toBeLessThan(2000);
  const stalled = createServer(() => {});
  await new Promise<void>(resolve => stalled.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { stalled.closeAllConnections(); stalled.close(); });
  const address = stalled.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  const url = "http://127.0.0.1:" + address.port;
  writeFileSync(join(repo, ".crosstalk.toml"), readFileSync(join(repo, ".crosstalk.toml"), "utf8").replace(relay.url, url));
  const untrusted = JSON.parse((await runHook("codex", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "test", tool_name: "Bash", tool_input: { command: "git merge topic" } }))).stdout);
  expect(untrusted.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(untrusted.hookSpecificOutput.permissionDecisionReason).toBe("crosstalk config changed: a human must run `xt trust`");
  const stalledConfig = trust(repo);
  writeFileSync(join(home, ".config/crosstalk/credentials.json"), JSON.stringify({ [credentialScope(stalledConfig)]: agentKey }), { mode: 0o600 });
  const expiredStart = Date.now();
  const expired = await invokeHook("codex", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "expired", tool_name: "Bash", tool_input: { command: "git merge topic" } }), Date.now() - 2000);
  expect(JSON.parse(expired.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(Date.now() - expiredStart).toBeLessThan(500);
  const began = Date.now();
  const timeout = JSON.parse((await runHook("codex", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "timeout", tool_name: "Bash", tool_input: { command: "git merge topic" } }))).stdout);
  expect(timeout.hookSpecificOutput.permissionDecisionReason).toMatch(/^crosstalk could not confirm the gate: /);
  expect(Date.now() - began).toBeGreaterThanOrEqual(1400); expect(Date.now() - began).toBeLessThan(2000);
});
test("installers preserve other settings and are repeatable", () => {
  const root = mkdtempSync(join(tmpdir(), "xt-install-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ model: "existing", hooks: { Stop: [{ hooks: [{ command: "other" }] }] } }));
  installHarness(root, "claude-code"); installHarness(root, "claude-code");
  const installed = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  installed.hooks.PreToolUse[0].hooks[0].timeout = 2;
  installed.hooks.PreToolUse[0].matcher = "old";
  installed.hooks.PreToolUse.push(structuredClone(installed.hooks.PreToolUse[0]));
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(installed));
  installHarness(root, "claude-code");
  const config = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  expect(config.hooks.PreToolUse).toHaveLength(1); expect(config.model).toBe("existing"); expect(config.hooks.Stop).toHaveLength(2); expect(config.hooks.PreToolUse[0].hooks[0].onFailure).toBeUndefined();
  expect(config.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
  const codexInstall = installHarness(root, "codex");
  expect(codexInstall).toContain("Each new git worktree"); expect(codexInstall).toContain("/hooks"); expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain('CROSSTALK_HARNESS = "codex"');
});

async function enforcementFixture() {
  const root = mkdtempSync(join(tmpdir(), "xt-enforce-")), repo = join(root, "repo"), home = join(root, "home");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(repo); mkdirSync(join(home, ".config/crosstalk"), { recursive: true }); vi.stubEnv("HOME", home);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.org"); git("commit", "--allow-empty", "-m", "base");
  const space = randomUUID(), humanKey = "h".repeat(40), agentKey = "a".repeat(40), execKey = "e".repeat(40);
  const relay = await startRelay({ database: join(root, "db"), signingKeyFile: join(root, "key"), rateLimit: { burst: 1000, perSecond: 1000 }, bootstrap: { space, principal: "human:test", humanKey, agentKey } }); cleanup.push(relay.close);
  const pin = "sha256:" + createHash("sha256").update(createPublicKey(readFileSync(join(root, "key"))).export({ type: "spki", format: "der" })).digest("hex");
  writeFileSync(join(repo, ".crosstalk.toml"), `space="${space}"\nrelay="${relay.url}"\nrelay_key="${pin}"\nstrict=true\n[deploy_commands]\nprod=['^\\s*deploy-prod(?:\\s|$)']\n[sequences.db]\nfloor_glob="migrations/*.sql"\nfloor_regex='^(\\d+)_'`);
  const config = trust(repo);
  writeFileSync(join(home, ".config/crosstalk/credentials.json"), JSON.stringify({ [credentialScope(config)]: agentKey }), { mode: 0o600 });
  const human = new RelayClient(config, { token: humanKey });
  const w = new Workspace(repo); cleanup.push(() => w.close());
  const own = await w.session("claude-code", "enforcement", Date.now(), "claude-code");
  const action = async (tool_name: string, tool_input: unknown) => JSON.parse((await runHook("claude-code", "PreToolUse", JSON.stringify({ cwd: repo, session_id: "enforcement", tool_name, tool_input }))).stdout).hookSpecificOutput;
  return { repo, git, space, relay, execKey, config, human, own, action };
}
test("new sequence files require a live reservation of this principal in edits and pre-commit", { timeout: 30000 }, async () => {
  const { repo, git, relay, own, action } = await enforcementFixture();
  const path = "migrations/001_new.sql";
  expect((await action("Write", { file_path: path })).permissionDecision).toBe("deny");
  await own.client.send("reserve", { sequence: "seq:db", floor: 1 });
  expect((await action("Write", { file_path: path }))?.permissionDecision).toBeUndefined();
  mkdirSync(join(repo, "migrations")); writeFileSync(join(repo, path), "select 1;"); git("add", path);
  const { runPreCommit } = await import("../src/githooks/index.js");
  expect((await runPreCommit(repo)).exitCode).toBe(0);
  await own.client.send("reserve", { sequence: "seq:db", abandon: 1 });
  expect((await runPreCommit(repo)).exitCode).toBe(1);

  await relay.close();
  expect((await action("Write", { file_path: "migrations/002_new.sql" }))?.permissionDecision).toBeUndefined();
});
test("configured deploy segments require an installed session lease and fail closed offline", { timeout: 30000 }, async () => {
  const { space, relay, execKey, config, human, own, action } = await enforcementFixture();
  const deploy = () => action("Bash", { command: "echo prepare && deploy-prod" });
  expect((await deploy()).permissionDecisionReason).toContain("xt claim env:prod");
  const code = "invite".repeat(10);
  await human.request("/invitations", { request_id: randomUUID(), principal: "ci:executor", role: "ci", code_hash: createHash("sha256").update(code).digest("hex") });
  expect((await fetch(relay.url + "/v2/spaces/" + space + "/enroll", { method: "POST", headers: { authorization: "Bearer " + code, "content-type": "application/json" }, body: JSON.stringify({ agentKey: execKey, humanKey: "unused".repeat(8) }) })).ok).toBe(true);
  await human.send("executor.enroll", { env: "prod", executor: "ci:executor", max_fence: 0 });
  const lease = await own.client.send("lease.claim", { resources: ["env:prod"] });
  expect((await deploy()).permissionDecision).toBe("deny");
  const executor = new RelayClient(config, { token: execKey });
  const { lease_id, fence } = lease.result as { lease_id: string; fence: number };
  await executor.request("/executor/install", { epoch: lease.epoch, env: "prod", lease_id, fence, max_fence: 0, dry_run: false });
  expect((await deploy())?.permissionDecision).toBeUndefined();

  await relay.close();
  expect((await deploy()).permissionDecision).toBe("deny");
});
test("commit-ish shell inputs block only draft content newly introduced to HEAD", { timeout: 30000 }, async () => {
  const { git, own, action } = await enforcementFixture();
  const base = git("rev-parse", "HEAD");
  git("switch", "-c", "draft"); git("commit", "--allow-empty", "-m", "draft"); const draft = git("rev-parse", "HEAD");
  await own.client.send("branch.set", { branch: "draft", head: draft, state: "draft" });
  git("commit", "--allow-empty", "-m", "tip"); const tip = git("rev-parse", "HEAD");
  git("switch", "main"); git("switch", "-c", "clean"); git("commit", "--allow-empty", "-m", "clean"); const clean = git("rev-parse", "HEAD"); git("switch", "main");
  for (const [command, denied] of [
    ["git merge " + draft, true], ["git rebase " + tip, true], ["git cherry-pick " + draft, true],
    ["git merge " + clean, false], ["git rebase " + clean, false], ["git cherry-pick " + base, false],
  ] as const) expect((await action("Bash", { command }))?.permissionDecision === "deny", command).toBe(denied);
});
