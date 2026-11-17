# Audit-export companion, version 2.0

This normative companion extends [crosstalk core 2.0](../protocol.md). **Audit exporter / verifier** conformance requires the fixed export set, both chains, signature verification and attest-then-publish order below. **Relay audit support** requires the endpoints and attestation below. A remote hook claiming this companion MUST enforce the ref protection below. Core HTTP binding, signatures and receiver rules apply; section numbers retain their core 1.0 origins.

## Endpoints and signature

Paths are relative to `/v2/spaces/{space}`.

| Method and path | Caller | Purpose |
|---|---|---|
| `GET /audit/head` | session, ci key, human admin key | `{head, exported_seq, lag}`. |
| `POST /audit/attest` | audit exporter ci key or human admin key | `{through_seq, xhash}` → signed audit head (12.3). |
| `POST /audit/published` | same | As attest, and advances the published cursor. |

The audit-head signature is padded base64 Ed25519 over UTF-8 of `space + epoch + decimal(through_seq) + through_hash + xhash`, concatenated without separators, using the relay signing key (core 11).

## 12. Audit export

### 12.1 Content

A conforming exporter exports: `lease` events touching `env:` or `branch:` keys, `branch_status`, `reservation`, `ask` events of kind `approval` and `answer` events to them, `decision`, `deployment`, `admin`. All other events (intents, messages, `path:`/`tree:` leases, question asks and their answers) are represented by skip lines. This exported set is fixed for the whole major version: an event body type added in a minor version is always exported as a skip line under `refs/crosstalk/audit/v2`, so exporters and relays of different minors compute the same `xhash`. Implementations MUST NOT make the set configurable; widening it requires a new major and audit ref.

### 12.2 Lines and chains

The export is a JSONL stream with its own hash chain, separate from the event chain. Each line is one event per relay event, in `seq` order:

- `{"x": "event", "event": <committed event>, "xprev": …, "xhash": …}`
- `{"x": "skip", "from_seq": n, "to_seq": n, "count": 1, "last_hash": <that event's hash>, "xprev": …, "xhash": …}`

`xhash = "sha256:" + hex(SHA-256(UTF-8(xprev) ‖ UTF-8(JCS(line without xhash))))`; the first line's `xprev` is the genesis value. Producers MUST emit one skip line per skipped event, so the chain is independent of batching. A verifier MUST check that the export chain is unbroken, that `seq` is contiguous across lines, that each exported event's hash is valid, and that each event's `prev_hash` equals the previous line's `hash` or `last_hash`. It cannot check skipped content; the signed head vouches for it.

### 12.3 Head and attestation

The head is `{space, epoch, through_seq, through_hash, xhash, relay_key, sig, exported_at}`. The exporter computes `xhash` for its lines and calls `/audit/attest`; the relay recomputes the export chain over its own events (from its last checkpoint), refuses with `conflict` if `xhash` differs and with `resync` if history is incomplete, and otherwise returns the signed head. After a successful push the exporter calls `/audit/published` so the relay advances its published cursor. Gates never wait for the export.

### 12.4 Git storage

The export is stored as an orphan commit chain on `refs/crosstalk/audit/v2`, pushed with `--force-with-lease` against the commit just read. A new epoch starts a new file set. The remote hook MUST allow updates under `refs/crosstalk/**` only from `ci:remote` or a human admin, fast-forward only, never deletes. The export is a read-only replica; nothing reads it back as authority. Because git history is replicated, text in it cannot be deleted later; this is why messages are not exported.
