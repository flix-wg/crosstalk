import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash, createPublicKey } from "node:crypto";
import { startRelay } from "../src/relay/index.js";
import { RelayClient, trust } from "../src/client/index.js";

test("CI merge CLI pins the relay without checkout config and blocks draft ancestry", { timeout: 30000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "xt-ci-")), space = randomUUID(), humanKey = "h".repeat(40), key = "c".repeat(40);
  const relay = await startRelay({ database: join(repo, "db"), signingKeyFile: join(repo, "key"), bootstrap: { space, principal: "human:test", humanKey, agentKey: "a".repeat(40) } });
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.org");
    const commit = (label: string) => { git("commit", "--allow-empty", "-m", label); return git("rev-parse", "HEAD"); };
    const base = commit("base");
    const pin = "sha256:" + createHash("sha256").update(createPublicKey(readFileSync(join(repo, "key"))).export({ type: "spki", format: "der" })).digest("hex");
    writeFileSync(join(repo, ".crosstalk.toml"), `space="${space}"\nrelay="${relay.url}"\nrelay_key="${pin}"\n`);
    const human = new RelayClient(trust(repo), { token: humanKey });
    const code = "invite".repeat(10);
    await human.request("/invitations", { request_id: randomUUID(), principal: "ci:checks", role: "ci", code_hash: createHash("sha256").update(code).digest("hex") });
    expect((await fetch(relay.url + "/v1/spaces/" + space + "/enroll", { method: "POST", headers: { authorization: "Bearer " + code, "content-type": "application/json" }, body: JSON.stringify({ agentKey: key, humanKey: "unused".repeat(8) }) })).ok).toBe(true);
    await human.send("policy.set", { protected_branches: ["main"] });
    git("switch", "-c", "draft"); const draft = commit("draft");
    await human.send("branch.set", { branch: "draft", head: draft, state: "draft" });
    git("switch", "-c", "feature"); const head = commit("intermediate");
    await human.send("branch.set", { branch: "feature", head, state: "ready" });
    git("switch", "-c", "clean", base); const clean = commit("clean");
    await human.send("branch.set", { branch: "clean", head: clean, state: "ready" });
    // CI must ignore even invalid, attacker-controlled repository configuration.
    writeFileSync(join(repo, ".crosstalk.toml"), "malicious invalid config");
    const run = (source: string, sha: string, fingerprint = pin, extra: string[] = []) => new Promise<{ code: number; output: string }>((res, reject) => {
      const p = spawn(process.execPath, [resolve("dist/cli/main.js"), "gate", "merge", "--relay", relay.url, "--relay-key", fingerprint, "--space", space, "--target", "main", "--source", source, "--head", sha, "--base", base, ...extra], { cwd: repo, env: { ...process.env, CROSSTALK_KEY: key }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; p.stdout.on("data", b => { output += b; }); p.stderr.on("data", b => { output += b; });
      p.on("error", reject); p.on("close", code => { expect(output).not.toContain(key); res({ code: code ?? 1, output }); });
    });
    const blocked = await run("feature", head);
    expect(blocked.code).toBe(1); expect(blocked.output).toContain("draft"); expect(blocked.output).toContain("human∶test");
    expect((await run("clean", clean)).code).toBe(0);
    expect((await run("clean", clean, "sha256:" + "0".repeat(64))).code).toBe(1);
    expect((await run("clean", clean, pin, ["--unexpected"])).code).toBe(2);
    await relay.close();
    expect((await run("clean", clean)).code).toBe(1);
  } finally { await relay.close(); rmSync(repo, { recursive: true, force: true }); }
});
