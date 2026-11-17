/** Command usage is available without repository configuration or credentials. */
export const help: Record<string, string> = {
  init: "Create a space and local config — --relay <url> --relay-key <fingerprint> --principal <human:name>",
  enroll: "Enroll using an invite entered in a terminal",
  trust: "Approve the configured space, relay URL and key in a terminal",
  board: "Show peers, leases and coordination state — --json",
  announce: "Post work intent <summary> — --res <prefixed-resource> --ttl <seconds> --id <intent-id> --close <intent-id> --state <done|abandoned>",
  claim: "Claim <prefixed-resource>... — --ttl <seconds> --note <text> --expect-lease <id> --lease-rev <rev>",
  release: "Release <lease-id>",
  reserve: "Reserve <seq:name> — --floor <n> --abandon <n> --note <text>",
  send: "Send <recipient> <text> — --context <uuid>",
  inbox: "Read messages — --ack <cursor>",
  ask: "Ask <human:name> <question> or cancel/withdraw <id> — --approval --option <text> --res <key> --blocks <scope> --head <oid> --artifact <digest> --deadline <time> --reason <text>",
  asks: "List human asks",
  answer: "Answer <ask-id> <choice> in a terminal — --text <text> --reaffirm --head <oid> --artifact <digest>",
  branch: "Set <wip|draft|ready|done> — --branch <name> --head <oid> --note <text> --pending <text> --owner <principal>",
  check: "Preview merge --target <branch> [--branch <source> --head <oid> --unknown-source] or deploy <env> --sha <oid> --artifact <digest> --lease <id> --fence <n> --holder <session>",
  override: "Record merge override — --branch <name> or --target <name>, --head <oid> --reason <text>",
  env: "Adopt an environment: adopt <env> --sha <oid> --artifact <digest>",
  admin: "Manage invite <principal> --role <role> --out <file> [--device <label>]; revoke <principal> [--device <label>] --reason <text>; revoke-lease <id> --reason <text>; unfreeze --reason <text>; policy set --protected-branch <branch> --gates.merge.unknown <pass|warn|block> --gates.merge.unknown_source <pass|warn|block> --gates.merge.stale_ready <pass|warn|block> --env <name> --require-on <branch> [--args <json>]",
  install: "Install hooks and MCP: <claude-code|codex|git-hooks> — --local; repeat in each new worktree",
  hook: "Run <claude-code|codex> <event> with JSON stdin, or git <pre-receive|post-receive|pre-commit|pre-push|seed> [ref]",
  relay: "Start relay — --db <path> --host <host> --port <port> --operator-key-file <path>; fingerprint --db <path>; serve <config.json>; restore <config.json> <space>. Non-loopback requires a TLS proxy and trustProxy in config.",
  mcp: "Serve the ten agent tools over MCP stdio",
  executor: "Operate deployment target: enroll|install|promote|status|reconcile <env> — --ticket <json-or-file> --lease <id> --fence <n>",
  audit: "Export or verify audit history: export|verify",
};
export function usage(command?: string): string {
  return "Usage: xt " + (command ?? "<command>") + " [arguments] [--help]\n" +
    (command ? help[command] ?? "Unknown command" : Object.entries(help).map(([name, text]) => "  " + name + "  " + text).join("\n")) +
    "\nCoordination commands accept --json; coordination mutations also accept --expect-rev <revision>. Resources require path:, tree:, branch:, env:, seq: or res: prefixes.";
}
