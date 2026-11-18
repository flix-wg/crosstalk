// Drives the merge-gate Action smoke test in .github/workflows/action-smoke.yml against a throwaway local relay.
// `start <dir>` writes the relay config, `setup <dir>` enrolls CI keys and sets policy,
// `status <dir> <branch> <head> <state>` sets the source branch status. Values go to $GITHUB_ENV; keys are masked.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayClient, trust } from "../dist/client/index.js";

const [command, dir, branch, head, state] = process.argv.slice(2);
const env = (name, value, secret = false) => {
  if (secret) console.log("::add-mask::" + value);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
};
const saved = () => JSON.parse(readFileSync(join(dir, "trial.json"), "utf8"));
const human = () => new RelayClient(trust(dir), { token: saved().humanKey });

if (command === "start") {
  const trial = { space: randomUUID(), humanKey: randomBytes(24).toString("hex"), url: "http://127.0.0.1:7331" };
  execFileSync("git", ["init", "-q", dir]); // trust() reads .crosstalk.toml from a git repository
  writeFileSync(join(dir, "trial.json"), JSON.stringify(trial));
  writeFileSync(join(dir, "relay.json"), JSON.stringify({ database: join(dir, "db"), signingKeyFile: join(dir, "key"), port: 7331, host: "127.0.0.1",
    bootstrap: { space: trial.space, principal: "human:trial", humanKey: trial.humanKey } }));
  env("XT_TRIAL_SPACE", trial.space); env("XT_TRIAL_RELAY", trial.url);
} else if (command === "setup") {
  const { space, url } = saved();
  writeFileSync(join(dir, ".crosstalk.toml"), `space="${space}"\nrelay="${url}"\nrelay_key="${process.env.XT_TRIAL_PIN}"\n`);
  const admin = human();
  for (const [principal, name] of [["ci:checks", "XT_TRIAL_KEY"], ["ci:remote", "XT_TRIAL_REMOTE_KEY"]]) {
    const code = randomBytes(24).toString("hex"), key = randomBytes(24).toString("hex");
    await admin.request("/invitations", { request_id: randomUUID(), principal, role: "ci", code_hash: createHash("sha256").update(code).digest("hex") });
    const res = await fetch(`${url}/v2/spaces/${space}/enroll`, { method: "POST", headers: { authorization: "Bearer " + code, "content-type": "application/json" },
      body: JSON.stringify({ agentKey: key, humanKey: randomBytes(24).toString("hex") }) });
    if (!res.ok) throw new Error(`enroll ${principal} failed: ${res.status}`);
    env(name, key, true);
  }
  await admin.send("policy.set", { protected_branches: ["main"], gates: { merge: { unknown_source: "block", unknown: "block" } } });
} else if (command === "status") {
  await human().send("branch.set", { branch, head, state });
} else throw new Error("usage: action-smoke.js start|setup|status <dir> [branch head state]");
