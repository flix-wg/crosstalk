import type { HookEvent, HookInput, HookOutput } from "./types.js";
const events: Record<string, HookEvent> = { SessionStart: "session_start", UserPromptSubmit: "before_prompt", PreToolUse: "before_action", Stop: "turn_end", SessionEnd: "session_end" };
export function event(name: string): HookEvent | undefined { return events[name] ?? Object.values(events).find(e => e === name); }
export function parse(stdin: string, patch = false): HookInput {
  const input = JSON.parse(stdin) as { session_id?: string; cwd?: string; tool_name?: string; tool_input?: { file_path?: string; notebook_path?: string; command?: string } };
  if (typeof input.session_id !== "string" || !input.session_id || typeof input.cwd !== "string" || !input.cwd) throw new Error("Invalid hook input");
  const paths = patch && input.tool_name === "apply_patch" ? patchPaths(input.tool_input?.command ?? "") : [input.tool_input?.file_path ?? input.tool_input?.notebook_path].filter((p): p is string => !!p);
  return { sessionId: input.session_id, cwd: input.cwd, action: input.tool_name === "Bash" ? { kind: "shell", command: input.tool_input?.command ?? "" } : paths.length ? { kind: "edit", paths } : { kind: "none" } };
}
export function patchPaths(patch: string): string[] { return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1]); }
export function encode(event: HookEvent, { context, decision, reason }: HookOutput): string {
  const hookEventName = Object.keys(events).find(k => events[k] === event);
  return JSON.stringify({ ...(context || decision ? { hookSpecificOutput: { hookEventName, ...(context ? { additionalContext: context } : {}), ...(decision ? { permissionDecision: decision, permissionDecisionReason: reason } : {}) } } : {}), ...(reason ? { systemMessage: reason } : {}) });
}

export function installEvents(matcher: string): Record<string, { matcher?: string }> {
  return Object.fromEntries(Object.keys(events).map(name => [name, name === "PreToolUse" ? { matcher } : {}]));
}
