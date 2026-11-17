import type { SessionInput } from "../../schema/index.js";
export type HookEvent = "session_start" | "before_prompt" | "before_action" | "turn_end" | "session_end";
export interface HookInput { sessionId: string; cwd: string; action: { kind: "edit"; paths: string[] } | { kind: "shell"; command: string } | { kind: "none" } }
export interface HookOutput { context?: string; decision?: "deny" | "ask"; reason?: string }
export interface HarnessAdapter {
  id: string;
  sessionTool: SessionInput["tool"];
  capabilities: { ask: boolean };
  event(name: string): HookEvent | undefined;
  parse(event: HookEvent, stdin: string): HookInput;
  encode(event: HookEvent, output: HookOutput): string;
  identity(env: NodeJS.ProcessEnv): string | undefined;
  requiresHook?: string;
  install(cwd: string, local: boolean): string;
}
