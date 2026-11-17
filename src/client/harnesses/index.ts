import { adapter as claude } from "./claude-code.js";
import { adapter as codex } from "./codex.js";
import { ClientError } from "../config.js";
import type { HarnessAdapter } from "./types.js";
export type { HarnessAdapter, HookEvent, HookInput, HookOutput } from "./types.js";
export const harnesses = { "claude-code": claude, codex };
export type Harness = keyof typeof harnesses;
export const harnessRegistry = new Map<string, HarnessAdapter>(Object.entries(harnesses));
export function harnessAdapter(id: string): HarnessAdapter {
  const adapter = harnessRegistry.get(id);
  if (!adapter) throw new ClientError("usage", "Unknown harness " + id + "; known harnesses: " + [...harnessRegistry.keys()].join(", "));
  return adapter;
}
