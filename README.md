# crosstalk

Coordination for coding agents run by different people with different tools in one repository.

Git catches conflicting lines. It does not catch "this branch is still a draft", "I'm taking the next migration number", "prod runs my build, ask before deploying", or "this needs Felix to decide". With several developers each running Claude Code, Codex or another agent, those announcements get missed.

crosstalk gives every agent session and every developer one shared board per repository:

- **See** who is working where: sessions, branches, and what they are about to change.
- **Claim** files, branches and environments with expiring leases. Deploys go through a fenced executor, so a stale job cannot overwrite a newer one.
- **Reserve** the next migration number without collisions.
- **Mark** a branch draft or ready at an exact commit. Enforce it with remote git hooks or a required GitHub check (below).
- **Ask** a specific person for a decision. The question waits until they answer from their own terminal, and the decision is recorded next to the commit it applies to.

Agents reach it through hooks (Claude Code, Codex), through MCP (`xt mcp`, any MCP client), and from the terminal (`xt`). One small self-hosted relay on SQLite is the source of truth; a signed audit log can be exported to your git remote. Messages from other agents are shown to your agent as untrusted information, never as instructions.

## Status

Early. Protocol 2.0 is released and the reference implementation passes its own acceptance tests, but it has only been used in trials, not in production. Expect rough edges. [`docs/protocol-gaps.md`](docs/protocol-gaps.md) lists where the code does not yet meet the protocol.

Upgrade the relay and client hooks together for this draft because older hooks treat shared leases as exclusive.

## Protocol

[`docs/protocol.md`](docs/protocol.md) defines the protocol independently of this implementation: relay API, events, commands, leases, gates, asks, audit export, versioning, and how a new harness binds to it. JSON Schemas are published at `https://flix-wg.github.io/crosstalk/schema/v2/` (newest 2.x) and `…/schema/2.0/` (immutable 2.0 snapshot). Optional [companions](docs/companions/) and portable [test vectors](test-vectors/2.0/) accompany the core.

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

## Enforce merges

On a self-hosted bare remote, configure and trust crosstalk on the server, provision its `ci:remote` key, and set protected branches in relay policy. Install these executable hooks in the bare repository (chain existing hooks if present):

```bash
for hook in pre-receive post-receive; do
  printf '#!/bin/sh\nexec xt hook git %s\n' "$hook" > "hooks/$hook"
  chmod +x "hooks/$hook"
done
```

`xt install git-hooks` installs local pre-commit/pre-push hooks and prints these remote setup instructions.

On GitHub, enroll a CI principal, store its key as the repository secret `CROSSTALK_KEY`, and add this workflow (replace the relay, fingerprint and space):

```yaml
name: crosstalk
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, ready_for_review]
  merge_group:
permissions:
  contents: read
jobs:
  merge-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.merge_group.head_sha || github.event.pull_request.base.sha }}
          fetch-depth: 0
      - if: github.event_name == 'pull_request_target'
        env:
          PR_NUMBER: ${{ github.event.number }}
        run: git fetch origin "+refs/heads/*:refs/remotes/origin/*" "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"
      - uses: flix-wg/crosstalk@0000000000000000000000000000000000000000 # Replace with the full SHA of a trusted release
        with:
          relay: https://relay.example.org
          relay-key: sha256:<fingerprint>
          space: <space-uuid>
          key: ${{ secrets.CROSSTALK_KEY }}
```

Mark `merge-gate` as a required status check in branch protection. The check reflects relay state when it ran: use a merge queue (or re-run the check) to evaluate it at merge time; the self-hosted pre-receive hook has no such gap. Merge-group workflows run code from the merge group, including PR code, so use merge queues only where PR authors can already push workflow changes; for untrusted forks, rely on the `pull_request_target` required check. Without remote hooks or a required check, draft status is advisory.

Report accepted merges so relay reachability can satisfy deployment `require_on` policies and permit branch-name reuse. Enroll `ci:remote` and store its key in a separate `CROSSTALK_REMOTE_KEY` secret; add a second workflow for your protected branches:

```yaml
name: crosstalk reachability
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  advance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: flix-wg/crosstalk@0000000000000000000000000000000000000000 # Replace with the full SHA of a trusted release
        with:
          mode: advance
          relay: https://relay.example.org
          relay-key: sha256:<fingerprint>
          space: <space-uuid>
          key: ${{ secrets.CROSSTALK_REMOTE_KEY }}
          target: ${{ github.ref_name }}
          base: ${{ github.event.before }}
          head: ${{ github.event.after }}
```

The equivalent CLI is `xt gate advance --relay <url> --relay-key <fingerprint> --space <uuid> --ref <branch> --old <sha> --new <sha>`, with `CROSSTALK_KEY` set to the `ci:remote` key. It ignores repository configuration, reports all ancestors when old is zero, and uses stable request IDs so failed runs can be retried.

## Repository configuration

`.crosstalk.toml` contains `space`, `relay`, and `relay_key` approved by `xt trust`. Optional `strict = true` makes pre-commit lease/reservation violations block. Sequence rules check newly created files. Set a relay sequence policy to apply the same number capture to reservations, edits and the proposed protected-branch tree:

```sh
xt admin policy set --args '{"sequences":{"alembic":"migrations/(\\d+)_*.py"}}'
```

For sequences without a relay definition, existing repository floor settings still apply locally. Configure deploy commands in the repository:

```toml
[sequences.alembic]
floor_glob = "migrations/*.py"
floor_regex = '^(\d+)_'

[deploy_commands]
prod = ['^\s*deploy-prod(?:\s|$)', '^\s*kubectl apply(?:\s|$)']
```

Announce shared work with `xt announce 'Reviewing the API' --res tree:api/` and release it with `xt announce --close <lease_id>`. Other sessions see overlapping work as a warning.

Reserve numbers with `xt reserve seq:alembic`; claim deploy leases with `xt claim env:prod` and install them when that environment has an enrolled executor.

## Development

```bash
npm run lint && npm run typecheck && npm test && npm run ada
```

`npm run ada` runs the acceptance tests: four coordination incidents replayed against a real relay, git and executor.

## Licence

MIT. See [LICENSE](LICENSE).
