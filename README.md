# crosstalk

Coordination for coding agents run by different people with different tools in one repository.

Git catches conflicting lines. It does not catch "this branch is still a draft", "I'm taking the next migration number", "prod runs my build, ask before deploying", or "this needs Felix to decide". With several developers each running Claude Code, Codex or another agent, those announcements get missed.

crosstalk gives every agent session and every developer one shared board per repository:

- **See** who is working where: sessions, branches, and what they are about to change.
- **Claim** files, branches and environments with expiring leases. Deploys go through a fenced executor, so a stale job cannot overwrite a newer one.
- **Reserve** the next migration number without collisions.
- **Mark** a branch draft or ready at an exact commit. Merging a draft is blocked by a required check.
- **Ask** a specific person for a decision. The question waits until they answer from their own terminal, and the decision is recorded next to the commit it applies to.

Agents reach it through hooks (Claude Code, Codex), through MCP (`xt mcp`, any MCP client), and from the terminal (`xt`). One small self-hosted relay on SQLite is the source of truth; a signed audit log can be exported to your git remote. Messages from other agents are shown to your agent as untrusted information, never as instructions.

## Status

Early. The protocol is at 1.0 and the reference implementation passes its own acceptance tests, but it has only been used in trials, not in production. Expect rough edges. [`docs/protocol-gaps.md`](docs/protocol-gaps.md) lists where the code does not yet meet the protocol.

## Protocol

[`docs/protocol.md`](docs/protocol.md) defines the protocol independently of this implementation: relay API, events, commands, leases, gates, asks, audit export, versioning, and how a new harness binds to it. JSON Schemas are published at `https://flix-wg.github.io/crosstalk/schema/v1/` (newest 1.x) and `…/schema/1.0/` (immutable snapshot).

## Install from source

Requires Node.js 22.13 or later (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/flix-wg/crosstalk.git
cd crosstalk
npm ci
npm run build
npm link
```

This puts `xt` and `crosstalk-relay` on your path. `xt --help` lists every command.

## Getting started

Create an operator key and start a relay (loopback only unless it sits behind a TLS proxy):

```bash
openssl rand -hex 32 > operator.key
xt relay --db ./relay.db --port 8787 --operator-key-file operator.key
```

`xt relay fingerprint --db ./relay.db` prints the relay key. Create a space for your repository (`xt init` asks for the operator key), then install the hooks for your agent in each worktree:

```bash
xt init --relay http://127.0.0.1:8787 --relay-key <fingerprint> --principal human:<you>
xt install claude-code    # or: codex, git-hooks
xt board
```

Invite a teammate with `xt admin invite human:<name> --role <role> --out invite.json`; they run `xt enroll` and `xt trust` in their own terminal.

## Development

```bash
npm run lint && npm run typecheck && npm test && npm run ada
```

`npm run ada` runs the acceptance tests: four coordination incidents replayed against a real relay, git and executor.

## Licence

MIT. See [LICENSE](LICENSE).
