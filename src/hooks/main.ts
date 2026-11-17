import { readFileSync } from "node:fs";
import { runHook } from "./index.js";
import { installHarness } from "./install.js";
try {
const [mode, harness, event] = process.argv.slice(2);

if (mode === "install") console.log(installHarness(process.cwd(), harness, event === "--local"));
else {
  const result = await runHook(harness, event, readFileSync(0, "utf8"));
  console.log(result.stdout); process.exitCode = result.exitCode;
}

} catch { console.error("crosstalk: hook installation/invocation failed; check arguments, configuration and existing MCP entries"); process.exitCode = 1; }
