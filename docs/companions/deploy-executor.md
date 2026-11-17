# Deploy-executor companion, version 2.0

This normative companion extends [crosstalk core 2.0](../protocol.md). **Deploy executor** conformance requires installation, serialized promotion, durable recovery and idempotent reports below. **Relay deployment support** requires the model, commands, endpoints, signatures and gate extension below. Core terminology, authorization, HTTP binding and receiver rules apply; section numbers below retain their core 1.0 origins.

For an env with an enrolled executor, the deploy gate MUST additionally block when no live state exists until a human adopts it. An env without an enrolled executor uses only the core deploy gate.

## Endpoints and schemas

Paths are relative to `/v2/spaces/{space}`.

| Method and path | Caller | Purpose |
|---|---|---|
| `POST /deploy/ticket` | session holding the env lease | Signed deploy ticket (9.4). |
| `POST /executor/install` | enrolled executor's ci key, direct | Validate (`dry_run: true`) or acknowledge a pending `env:` lease (9.5.2). |
| `POST /deploy/authorize` | enrolled executor's ci key, direct | Signed 30 s authorization for a ticket (9.4). |
| `POST /deploy/report` | enrolled executor's ci key, direct | Deployment record; body = `deployment.record` args; the relay uses `op` as `request_id`. |

Install schema: `https://flix-wg.github.io/crosstalk/schema/v2/install.json`, body `{epoch, lease_id, env, fence, max_fence, dry_run}`. Ticket request and payload schema: `https://flix-wg.github.io/crosstalk/schema/v2/deploy.json`. Deployment bodies and deploy commands are included in the v2 event and command schemas. `env.adopt` requires a human key; `executor.enroll` requires an admin human key, subject to core 10.4.

Ticket and authorization signatures are padded base64 Ed25519 signatures over UTF-8 of `JCS(payload)` using the relay signing key (core 11).

### 5.11 Deployment records and live state

A deployment record is one executor attempt or one adoption: `env`, `sha` attempted, `artifact` digest attempted, `fence`, `op` (UUID of the executor operation), `exec_seq`, `outcome` (`promoted`, `failed`, `reconciled`, `adopted`) and `live_after` (the digest the target reported as live afterwards, or `null` if unknown). Records come only from executor reports and human adoption.

**Live state** per env is derived from the record with the highest `exec_seq` (ties broken by higher `seq`):

- `live_artifact` = that record's `live_after` (`null` = unknown);
- `live_sha` = its `sha` if `live_after = artifact`; otherwise the `sha` of the newest earlier record whose `artifact = live_after`; otherwise unknown.

Adoption records have `exec_seq = 0` and `op = null`. Lease expiry never means "env is empty".

### 7.3 Deploy

| Op | Allowed for | Args | Effect and events |
|---|---|---|---|
| `deployment.record` | the env's enrolled executor, ci key direct (normally via `/deploy/report`) | **all of** `env`, `sha`, `artifact`, `fence`, `op`, `exec_seq` (≥ 1), `live_after`, `outcome` (`promoted`/`failed`/`reconciled`) | Event `deployment`. `promoted` requires `live_after = artifact`. A repeat for the same `op` with identical content returns the stored record; different content is `idempotency_mismatch`; an `exec_seq` already used by another op is `conflict`. |
| `env.adopt` | human key | **`env`**, **`sha`** (non-null), **`artifact`** | Record with `outcome: adopted`, `exec_seq: 0`, `op: null`, `live_after = artifact`. Allowed only before the first promote of that env (`conflict` afterwards). |
| `executor.enroll` | admin | **`env`**, **`executor`** (active `ci:` principal), **`max_fence`** | Revoke active leases on `env:<env>`; set `fence_counter = max(fence_counter, max_fence) + 1`; pin the executor to the current epoch. Event `admin`/`executor_enrolled`. Result `{env, epoch, fence_floor}`. |

### 9.4 Deploy tickets and authorizations

1. **Ticket.** The lease holder's session calls `POST /deploy/ticket` with `{env, sha, artifact, lease_id, fence, op}` (`op` is a fresh UUID naming the deploy operation). The relay checks that this session holds the installed lease with this fence and that the space is not frozen, and returns `{payload, signature}` with payload `{env, sha, artifact, lease_id, fence, op, kind: "deploy_ticket", space, epoch, holder (session uuid), principal, expires_at}`. A ticket is valid for 10 minutes and carries no reusable credential.
2. **Authorization.** The executor calls `POST /deploy/authorize` with `{ticket}`. The relay verifies the ticket signature, space, epoch and expiry, that the caller is the env's executor enrolled in this epoch, that the holder session is still open and belongs to the ticket's principal, and evaluates the deploy gate in the same transaction. On pass it returns `{payload, signature}` with payload `{kind: "deploy_authorization", space, epoch, env, sha, artifact, lease_id, fence, op, holder, principal, exec_allowed_until}`, valid 30 s. On block it returns an error (`frozen`, or `conflict` with the gate result in `details`).

`expires_at` and `exec_allowed_until` are integers in epoch milliseconds (an exception to the RFC 3339 rule). Both payloads are signed as in 11.2.

### 9.5 Deploy executor

The executor runs on the deploy target and is the only component that changes what is live. It runs only operator-configured commands: a `promote` command that takes an artifact digest and makes exactly that digest live, and a `live` command that prints the digest live now. Callers choose which artifact, never how to deploy.

#### 9.5.1 State

The executor MUST persist, crash-safely (write, fsync, rename, fsync directory): `epoch`, `max_fence`, `installed {epoch, lease_id, fence}`, `exec_seq`, `needs_reconcile`, and one record per operation: `started`, then one terminal record `{op, fingerprint, exec_seq, lease_id, fence, sha, artifact, outcome, live_after, reported}`, where `fingerprint = sha256(JCS({env, sha, artifact, lease_id, fence, op}))`. All operations on one env MUST be serialized by one exclusive lock that stays held until every child process of the operation has exited. No process may write executor state without holding it.

#### 9.5.2 Install

Under the lock (if the lock is busy beyond `timeout + 10 s`, refuse, write nothing, and report busy): refuse if `needs_reconcile` or any operation is `started`; if `installed` already equals `{epoch, lease_id, fence}` skip to acknowledgment; otherwise call `/executor/install` with `dry_run: true`, then persist `max_fence = fence` and `installed`, then call it with `dry_run: false`. The relay accepts only if the epoch is current, the lease is `pending` (or already `held` for a repeated acknowledgment), unexpired, covers exactly this env, carries this fence, and `fence > max_fence`.

#### 9.5.3 Promote

Under the lock: an existing record for `op` with another fingerprint → refuse (`idempotency_mismatch`); a terminal one → return it (and re-queue its report); a `started` one → set `needs_reconcile` and refuse. Refuse if `needs_reconcile`, if `fence ≠ installed.fence`, or if the relay epoch differs from the pinned one. Obtain and verify the authorization (signature with the pinned relay key, every field equal to the ticket, unexpired on the executor's monotonic clock). Allocate `n = max(exec_seq, highest exec_seq in records) + 1`, persist `exec_seq = n` first, then the `started` record. Run `promote <artifact>` with a timeout, then `live`. Outcome `promoted` only if `promote` exited 0 and `live` printed exactly `artifact`; otherwise `failed`. If `live` fails or prints no digest, `live_after = null` and `needs_reconcile` is set.

#### 9.5.4 Recovery

A `started` record means "unknown whether it switched". The executor MUST refuse everything except status until a human reconciles: take the lock (terminating stale holders only after human confirmation), run `live`, write a terminal `reconciled` record for every `started` operation, set `exec_seq` to the highest recorded value, clear `needs_reconcile`.

#### 9.5.5 Reports

Every terminal record with `reported: false` MUST be sent to `/deploy/report` and marked reported only after the relay's receipt. Duplicates are harmless; the relay deduplicates by `op`.

**What this enforces.** A stale holder cannot promote, because its fence no longer equals `installed.fence` once a successor installs, and install cannot run while an operation is in flight. A ticket for artifact A cannot deploy B. **Not covered:** a `promote` command that ignores its argument, and deploy paths that bypass the executor. There is no break-glass in 2.0: while the relay is down, executor deploys are impossible; operators deploy by hand and reconcile afterwards.

