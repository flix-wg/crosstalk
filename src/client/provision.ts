import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClientError, loadConfig } from "./config.js";
import { loadAgentKey, loadHumanKey } from "./credentials.js";
import { credentialScope } from "./session.js";
import type { RelayClient } from "./http.js";
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function saveKey(scope: string, key: string, human: boolean): void {
  if (human) {
    const command = process.platform === "darwin" ? "security" : "secret-tool";
    // Never inherit child output: keychain errors must not echo key arguments.
    try {
        const args = command === "security" ? ["add-generic-password", "-U", "-s", "crosstalk", "-a", scope, "-w", key] : ["store", "--label=Crosstalk human key", "service", "crosstalk", "account", scope];
        execFileSync(command, args, { input: command === "security" ? undefined : key, timeout: 10000, stdio: ["pipe", "ignore", "ignore"] }); return;
      }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new ClientError("credentials_unavailable", "Cannot save human key to keychain"); }
    console.error("Using a separate mode 0600 human credential file");
  }
  const dir = join(homedir(), ".config/crosstalk"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, human ? "human-credentials.json" : "credentials.json");
  const values = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, string> : {};
  values[scope] = key;
  const temp = file + "." + randomUUID(); writeFileSync(temp, JSON.stringify(values), { mode: 0o600, flag: "wx" }); renameSync(temp, file);
}
function localKeys(scope: string): { agentKey: string; humanKey: string } {
  let agentKey: string, humanKey: string;
  try { agentKey = loadAgentKey(scope); }
  catch (e) {
    if (!(e instanceof ClientError) || e.code !== "credentials_unavailable") throw e;
    agentKey = secret(); saveKey(scope, agentKey, false);
  }
  try { humanKey = loadHumanKey(scope); }
  catch (e) {
    if (!(e instanceof ClientError) || e.code !== "credentials_unavailable") throw e;
    humanKey = secret(); saveKey(scope, humanKey, true);
  }
  return { agentKey, humanKey };
}
async function provision(relay: string, path: string, token: string, input: unknown): Promise<void> {
  try {
    const response = await fetch(relay + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) throw new ClientError("provision_failed", "Relay refused provisioning");
  } catch (e) { if (e instanceof ClientError) throw e; throw new ClientError("unknown", "Provisioning outcome unknown; keys are saved locally, retry with the same configuration"); }
}
export async function initialize(repo: string, input: { relay: string; relayKey: string; principal: string; operatorKey: string }): Promise<void> {
  const space = randomUUID();
  const file = join(repo, ".crosstalk.toml");
  if (!existsSync(file)) writeFileSync(file, `space = ${JSON.stringify(space)}\nrelay = ${JSON.stringify(input.relay)}\nrelay_key = ${JSON.stringify(input.relayKey)}\n`, { flag: "wx" });
  const config = loadConfig(repo); // Validate origin before transmitting operator credentials.
  if (config.relay !== new URL(input.relay).origin || config.relay_key !== input.relayKey) throw new ClientError("conflict", "Existing config names a different relay");
  const scope = credentialScope(config);
  const { agentKey, humanKey } = localKeys(scope);
  await provision(config.relay, "/v1/init", input.operatorKey, { space: config.space, principal: input.principal, agentKey, humanKey });
  config.trust();
}
export async function enroll(repo: string, code: string): Promise<void> {
  const config = loadConfig(repo);
  // Enrollment also explicitly reviews/pins this config through the CLI's TTY flow.
  const scope = credentialScope(config);
  // Each invitation rotates credentials, while retrying the same invitation keeps its fingerprint.
  const { agentKey, humanKey } = localKeys(scope + "/enroll/" + digest(code));
  await provision(config.relay, "/v1/spaces/" + config.space + "/enroll", code, { agentKey, humanKey });
  saveKey(scope, agentKey, false); saveKey(scope, humanKey, true);
  config.trust();
}
export async function invite(client: RelayClient, principal: string, role: string, file: string, device?: string): Promise<void> {
  const code = secret();
  // Write before requesting so a lost response cannot lose the invitation capability.
  writeFileSync(file, code + "\n", { mode: 0o600, flag: "wx" });
  await client.request("/invitations", { request_id: randomUUID(), principal, role, device, code_hash: digest(code) });
}
