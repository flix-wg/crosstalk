import { join } from "node:path";
import { save, installJSONHooks } from "./install.js";
import { event, parse, encode, installEvents } from "./wire.js";
import type { HarnessAdapter } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml, stringify } from "smol-toml";
export const adapter: HarnessAdapter = {
  id: "codex", sessionTool: "codex", capabilities: { ask: false }, event,
  parse: (_event, stdin) => parse(stdin, true),
  encode: (event, output) => encode(event, output.decision === "ask" ? { ...output, decision: "deny", reason: output.reason?.toLowerCase().includes("check with your developer") ? output.reason : (output.reason ?? "crosstalk: permission required") + "; check with your developer" } : output),
  identity: env => env.CODEX_SESSION_ID ?? env.CODEX_THREAD_ID,
  requiresHook: "Codex hooks have not run yet. Your developer must trust .codex/ and review the hooks via /hooks.",
  install: (cwd) => installJSONHooks(cwd, "codex", {
    file: ".codex/hooks.json",
    events: installEvents("^(Edit|Write|apply_patch|Bash)$"),
    mcp(cwd) {
      const configFile = join(cwd, ".codex/config.toml");
      const config = existsSync(configFile) ? parseToml(readFileSync(configFile, "utf8")) : {};
      const servers = (config.mcp_servers ?? {}) as Record<string, unknown>;
      const entry = { command: "xt", args: ["mcp"], env: { CROSSTALK_HARNESS: "codex" } };
      if (servers.crosstalk && JSON.stringify(servers.crosstalk) !== JSON.stringify(entry)) throw new Error("Existing crosstalk MCP entry differs; review it before installation");
      config.mcp_servers = { ...servers, crosstalk: entry } as typeof config.mcp_servers;
      save(configFile, stringify(config));
    },
    notice: "Installed. Codex requires trusting .codex/ and reviewing hooks via /hooks; changed definitions need review again."
  })
};
