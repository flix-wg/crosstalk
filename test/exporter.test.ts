import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash, createPublicKey } from "node:crypto";
import { startRelay, restoreDatabase } from "../src/relay/index.js";
import { trust, RelayClient, credentialScope } from "../src/client/index.js";
import { exportOnce, verify, AUDIT_REF } from "../src/exporter/index.js";
import { GENESIS_PREV_HASH } from "../src/schema/index.js";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
test("bare-repository exports attest both chains, retry concurrent writers, retain restored epochs and detect the first tampered line", { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xt-audit-")), repo = join(root, "remote.git"), home = join(root, "home");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(home, ".config/crosstalk"), { recursive: true }); vi.stubEnv("HOME", home);
  execFileSync("git", ["init", "--bare", repo], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const space = randomUUID(), humanKey = "h".repeat(40), agentKey = "a".repeat(40), ciKey = "c".repeat(40);
  const settings = { database: join(root, "db"), signingKeyFile: join(root, "key"), rateLimit: { burst: 1000, perSecond: 1000 }, bootstrap: { space, principal: "human:test", humanKey, agentKey } };
  let relay = await startRelay(settings); cleanup.push(() => relay.close());
  const pin = "sha256:" + createHash("sha256").update(createPublicKey(readFileSync(join(root, "key"))).export({ type: "spki", format: "der" })).digest("hex");
  const configure = () => {
    writeFileSync(join(repo, ".crosstalk.toml"), `space="${space}"\nrelay="${relay.url}"\nrelay_key="${pin}"\n`);
    const config = trust(repo);
    writeFileSync(join(home, ".config/crosstalk/credentials.json"), JSON.stringify({ [credentialScope(config)]: ciKey }), { mode: 0o600 });
    return config;
  };
  let config = configure(); const human = new RelayClient(config, { token: humanKey }), ci = new RelayClient(config, { token: ciKey });
  const code = "invite".repeat(10);
  await human.request("/invitations", { request_id: randomUUID(), principal: "ci:remote", role: "ci", code_hash: createHash("sha256").update(code).digest("hex") });
  expect((await fetch(relay.url + "/v1/spaces/" + space + "/enroll", { method: "POST", headers: { authorization: "Bearer " + code, "content-type": "application/json" }, body: JSON.stringify({ agentKey: ciKey, humanKey: "unused".repeat(8) }) })).ok).toBe(true);
  const opened = await new RelayClient(config, { token: agentKey }).request<{ token: string }>("/sessions", { tool: "cli", harness_session_id: "test", machine: "test", worktree: repo, branch: null, head: null });
  const session = new RelayClient(config, { token: opened.result.token });
  await session.send("message.send", { to: ["all"], context_id: randomUUID(), parts: [{ kind: "text", text: "private message excluded" }] });
  await expect(ci.request("/audit/attest", { through_seq: 1, xhash: GENESIS_PREV_HASH })).rejects.toMatchObject({ code: "conflict" });
  await expect(session.request("/audit/attest", { through_seq: 0, xhash: GENESIS_PREV_HASH })).rejects.toMatchObject({ code: "not_authorized" });
  const concurrent = await Promise.all([exportOnce(repo), exportOnce(repo)]);
  expect(concurrent[0].through_seq).toBe(concurrent[1].through_seq);
  expect(verify(repo).xhash).toBe(concurrent[0].xhash);
  expect(git("rev-list", "--count", AUDIT_REF)).toBe("1");
  const ask = await session.send("ask.open", { kind: "approval", to: "human:test", question: "Approve?", blocks: ["merge:branch:topic"], bound_head: "a".repeat(40) });
  await human.send("ask.answer", { ask_id: (ask.result as { ask_id: string }).ask_id, choice: "approve" }, 1);
  // A signed attestation is not delivery: a rejected push must leave the exported cursor unchanged.
  const exportedSeq = async () => (await ci.request<{ audit: { exported_seq: number } }>("/board")).result.audit.exported_seq;
  const before = await exportedSeq(), reject = join(repo, "hooks", "pre-receive");
  writeFileSync(reject, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(exportOnce(repo)).rejects.toMatchObject({ code: "audit_push_failed" });
  expect(await exportedSeq()).toBe(before); rmSync(reject);
  const fetcher = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/audit/published")) return Response.json({ error: { code: "not_authorized" } }, { status: 403 });
    return fetcher(url, init);
  });
  await expect(exportOnce(repo)).rejects.toMatchObject({ code: "not_authorized" });
  const pushed = git("rev-parse", AUDIT_REF); expect(await exportedSeq()).toBe(before);
  vi.restoreAllMocks();
  const exported = await exportOnce(repo); expect(verify(repo).through_seq).toBe(exported.through_seq);
  expect(git("rev-parse", AUDIT_REF)).toBe(pushed); expect(await exportedSeq()).toBe(exported.through_seq);
  await expect(session.request("/audit/published", { through_seq: exported.through_seq, xhash: exported.xhash })).rejects.toMatchObject({ code: "not_authorized" });
  const paths = git("ls-tree", "-r", "--name-only", AUDIT_REF).split("\n"); const file = paths.find(p => p.endsWith(".jsonl"))!;
  const text = git("show", AUDIT_REF + ":" + file);
  expect(text).not.toContain("private message excluded"); expect(text).toContain('"x":"skip"'); expect(text).toContain('"type":"answer"'); expect(text).toContain('"type":"decision"');
  const board = await ci.request<{ audit: { exported_seq: number } }>("/board"); expect(board.result.audit.exported_seq).toBe(exported.through_seq);
  // A failed read of an existing base blob must not be treated as an empty day file.
  const bin = join(root, "fail-show"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$3" = "show" ]; then exit 42; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  const oldPath = process.env.PATH!; vi.stubEnv("PATH", bin + ":" + oldPath);
  try {
    expect((await exportOnce(repo)).through_seq).toBe(exported.through_seq); // No historical blob reads on an unchanged ref.
    await session.send("message.send", { to: ["all"], context_id: randomUUID(), parts: [{ kind: "text", text: "new suffix" }] });
    await expect(exportOnce(repo)).rejects.toMatchObject({ status: 42 });
  } finally { vi.stubEnv("PATH", oldPath); }
  expect(git("rev-parse", AUDIT_REF)).toBe(pushed);
  await relay.close(); restoreDatabase(settings.database, space); relay = await startRelay(settings); config = configure();
  const restored = await exportOnce(repo); expect(restored.epoch).not.toBe(exported.epoch); expect(verify(repo).epoch).toBe(restored.epoch);
  expect(git("ls-tree", "-r", "--name-only", AUDIT_REF)).toContain("epochs/" + restored.epoch + "/events/");
  expect((await exportOnce(repo)).xhash).toBe(restored.xhash);
  // Modify one historic exported line with real Git plumbing, leaving all attestations intact.
  const index = join(root, "index"), env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.org" };
  const plumbing = (args: string[], input?: string) => execFileSync("git", ["-C", repo, ...args], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  plumbing(["read-tree", AUDIT_REF]);
  const altered = text.replace('"seq":1', '"seq":2') + "\n", blob = plumbing(["hash-object", "-w", "--stdin"], altered);
  plumbing(["update-index", "--cacheinfo", "100644", blob, file]); const tree = plumbing(["write-tree"]), commit = plumbing(["commit-tree", tree, "-p", git("rev-parse", AUDIT_REF)], "tamper\n");
  git("update-ref", AUDIT_REF, commit);
  expect(() => verify(repo)).toThrow(file + ":1:");
  expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/master");
});
