import { readFileSync } from "node:fs";
import { RelayClient, loadConfig, loadHumanKey, credentialScope } from "../client/index.js";
import { runPreReceive, runPostReceive, runPreCommit, runPrePush, runSeed } from "./index.js";
import { installGitHooks } from "./install.js";
try {
const [mode, , hook, ref] = process.argv.slice(2);
if (mode === "install") console.log(installGitHooks(process.cwd()));
else {
  let result;
  if (hook === "pre-commit") result = await runPreCommit();
  else if (hook === "seed") {
    // The CLI registry obtains controlling-terminal confirmation before dispatch.
    if (!process.stdin.isTTY || !ref) throw new Error("Seed requires a human terminal and ref");
    const config = loadConfig(process.cwd()); config.assertTrusted();
    const client = new RelayClient(config, { token: loadHumanKey(credentialScope(config)) });
    result = await runSeed(ref, { client });
  } else {
    const input = readFileSync(0);
    if (hook === "pre-receive") result = await runPreReceive(input);
    else if (hook === "post-receive") result = await runPostReceive(input);
    else if (hook === "pre-push") result = await runPrePush(input.toString("utf8"));
    else throw new Error("Unknown Git hook");
  }
  if (result.stdout) console.error(result.stdout); process.exitCode = result.exitCode;
}

} catch { console.error("crosstalk: Git hook failed; check arguments, credentials and existing hook scripts"); process.exitCode = 1; }
