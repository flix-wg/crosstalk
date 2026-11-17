#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./index.js";
try {
  const bridge = new Bridge();
  await bridge.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void bridge.close(); });
  process.stdin.once("end", () => { void bridge.close(); });
} catch { console.error("crosstalk: bridge could not start; check trusted configuration and agent credentials"); process.exitCode = 1; }
