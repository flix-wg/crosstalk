# crosstalk protocol 2.0: implementation gaps

Where the reference implementation does not yet meet `docs/protocol.md`. One line each: protocol says / code does / location.

## Commands and state

- Reservation abandon: emitted as a second `reservation` event that differs from the original only by the free-text note `abandoned…`, so consumers cannot tell it apart structurally (protocol forbids acting on free text). Candidate for an optional `abandoned` field in 2.1. `src/core/coordination.ts:25`
- Reachability: `ref.advance` writes no event, so the facts behind `require_on` are not in the log or audit export. Documented as such; consider an event in a later minor. `src/core/coordination.ts:118`
- Relay sweep builds its context from the first space's epoch; per-space helpers override it, but a multi-space relay depends on that override everywhere. `src/relay/index.ts:247`


## Client enforcement limits

- Draft ancestry tracks only recorded heads and current tips; cherry-picks and older draft commits can evade remote/CI detection (9.2). CI needs fetched branch tips and commit history.
- GitHub required checks evaluate current board state when they run; later status changes do not automatically rerun GitHub checks. The protected-branch push workflow reports `ref.advance`; installations without it need remote reporting or admin seeding.
