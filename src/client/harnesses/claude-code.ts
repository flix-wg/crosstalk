import { join } from "node:path";
import { json, save, installJSONHooks } from "./install.js";
import { event, parse, encode, installEvents } from "./wire.js";
import type { HarnessAdapter } from "./types.js";
export const adapter: HarnessAdapter = {
  id: "claude-code", sessionTool: "claude-code", capabilities: { ask: true }, event,
  parse: (_event, stdin) => parse(stdin, true),
  encode, identity: env => env.CLAUDE_CODE_SESSION_ID,
  install: (cwd, local) => installJSONHooks(cwd, "claude-code", {
    file: local ? ".claude/settings.local.json" : ".claude/settings.json",
    events: installEvents("^(Edit|Write|MultiEdit|NotebookEdit|Bash)$"),
    mcp(cwd) {
      const mcpFile = join(cwd, ".mcp.json"), mcp = json(mcpFile);
      const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
      if (servers.crosstalk && JSON.stringify(servers.crosstalk) !== JSON.stringify({ command: "xt", args: ["mcp"] })) throw new Error("Existing crosstalk MCP entry differs; review it before installation");
      save(mcpFile, JSON.stringify({ ...mcp, mcpServers: { ...servers, crosstalk: { command: "xt", args: ["mcp"] } } }, null, 2) + "\n");
    },
    notice: "Installed Claude Code hooks and MCP server."
  })
};
