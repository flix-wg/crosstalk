# crosstalk protocol 1.0: implementation gaps

Where the reference implementation does not yet meet `docs/protocol.md`. One line each: protocol says / code does / location.

## Commands and state

- `executor.reconcile`: protocol defines it as a human-key op; the schema accepts it but no handler exists, so the relay answers HTTP 400 `unsupported_op` until implemented. `src/schema/command-schema.ts:74`, `src/core/commands.ts:52-56`
- Branch state `cleared`: allowed in the event schema and treated as "no status" by the merge gate, but no op produces it. `src/schema/event-schema.ts:80`, `src/core/gates.ts:53`
- Reservation abandon: emitted as a second `reservation` event that differs from the original only by the free-text note `abandoned…`, so consumers cannot tell it apart structurally (protocol forbids acting on free text). Candidate for an optional `abandoned` field in 1.1. `src/core/coordination.ts:25`
- Reachability: `ref.advance` writes no event, so the facts behind `require_on` are not in the log or audit export. Documented as such; consider an event in a later minor. `src/core/coordination.ts:118`
- Relay sweep builds its context from the first space's epoch; per-space helpers override it, but a multi-space relay depends on that override everywhere. `src/relay/index.ts:247`
