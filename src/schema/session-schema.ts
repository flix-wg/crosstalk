export const sessionSchema = {
  $id: "https://flix-wg.github.io/crosstalk/schema/v2/session.json",
  type: "object", additionalProperties: false,
  required: ["tool", "harness_session_id", "machine", "worktree", "branch", "head"],
  properties: {
    // Free identifier naming the client (claude-code, codex, cursor, mcp, cli, ci, ...); informational, never authority.
    tool: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    harness_session_id: { type: "string", minLength: 1, maxLength: 512 },
    machine: { type: "string", minLength: 1, maxLength: 280 },
    worktree: { type: ["string", "null"], maxLength: 4096 },
    branch: { type: ["string", "null"], maxLength: 512 },
    head: { type: ["string", "null"], pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
  },
};
export interface SessionInput {
  tool: string;
  harness_session_id: string;
  machine: string;
  worktree: string | null;
  branch: string | null;
  head: string | null;
}

export interface InstallInput {
  epoch: string; lease_id: string; env: string; fence: number; max_fence: number; dry_run: boolean;
}
export const installSchema = {
  $id: "https://flix-wg.github.io/crosstalk/schema/v2/install.json",
  type: "object", additionalProperties: false,
  required: ["epoch", "lease_id", "env", "fence", "max_fence", "dry_run"],
  properties: {
    epoch: { type: "string", format: "uuid" }, lease_id: { type: "string", format: "uuid" },
    env: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
    fence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    max_fence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    dry_run: { type: "boolean" },
  },
};
