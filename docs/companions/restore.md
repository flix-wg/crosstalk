# Restore companion, version 2.0

This normative companion extends [crosstalk core 2.0](../protocol.md). **Restore-capable relay** conformance requires the atomic restore and recovery rules below. Core clients retain the epoch invalidation rule even when their relay does not implement restore. The `admin` action `epoch_started` is produced by this companion; restore also produces `gates_frozen` and lease revocations. Section references use the 2.0 numbering.

### 13.4 Backup restore and epochs

Restoring a backup may lose acknowledged writes. Restore MUST therefore be an explicit operation that, in one transaction: starts a new `epoch` (event `admin`/`epoch_started`), revokes every `held` or `pending` lease (holders claim again and get new fences), and freezes the space (event `admin`/`gates_frozen`). While frozen, `/check`, deploy tickets, deploy authorizations and `reserve` return `frozen`. Before `space.unfreeze` succeeds, every executor MUST re-enroll in the new epoch (which raises the fence counter above the executor's `max_fence`). Admins SHOULD raise every sequence floor above the highest value seen in the repository, the audit export and client receipts plus a safety gap, and SHOULD re-check requirements and decisions against the audit export. Clients that see a new `epoch` MUST drop cursors and cached boards.
