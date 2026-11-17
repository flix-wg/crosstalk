import type { SqlTx } from "./types.js";

const migrations = [
  [
    "CREATE TABLE spaces (space TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL)",
    "CREATE TABLE fence_counters (space TEXT PRIMARY KEY REFERENCES spaces(space), value INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE events (space TEXT NOT NULL REFERENCES spaces(space), seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(space, seq))",
    "CREATE TABLE receipts (space TEXT NOT NULL REFERENCES spaces(space), principal TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(space, principal, request_id))",
    "CREATE TABLE outbox (space TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(space, seq), FOREIGN KEY(space, seq) REFERENCES events(space, seq))",
    "CREATE TABLE audit_state (space TEXT PRIMARY KEY REFERENCES spaces(space), seq INTEGER NOT NULL DEFAULT 0)",
  ],
  [
    "CREATE TABLE principals (space TEXT NOT NULL REFERENCES spaces(space), principal TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','ci')), revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(space, principal))",
    "CREATE TABLE credentials (id TEXT PRIMARY KEY, space TEXT NOT NULL, principal TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('agent','human','ci')), secret_hash TEXT NOT NULL UNIQUE, FOREIGN KEY(space, principal) REFERENCES principals(space, principal))",
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, space TEXT NOT NULL, principal TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES credentials(id), tool TEXT NOT NULL, harness_session_id TEXT NOT NULL, machine TEXT NOT NULL, worktree TEXT, branch TEXT, head TEXT, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(space, principal) REFERENCES principals(space, principal))",
    "CREATE INDEX sessions_owner ON sessions(space, principal)",
    "CREATE TABLE presence (session TEXT PRIMARY KEY REFERENCES sessions(id), state TEXT NOT NULL, doing TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ],
  [
    "CREATE TABLE leases (space TEXT NOT NULL REFERENCES spaces(space), lease_id TEXT NOT NULL, holder TEXT NOT NULL REFERENCES sessions(id), resources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','held','released','expired','revoked')), fence INTEGER NOT NULL, rev INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, supersedes TEXT, superseded_by TEXT, PRIMARY KEY(space, lease_id))",
    "CREATE TABLE lease_keys (space TEXT NOT NULL, key TEXT NOT NULL, lease_id TEXT NOT NULL, PRIMARY KEY(space, key, lease_id), FOREIGN KEY(space, lease_id) REFERENCES leases(space, lease_id))",
    "CREATE INDEX leases_deadline ON leases(state, expires_at)",
    "CREATE INDEX leases_holder ON leases(space, holder)",
  ],
  [
    "CREATE TABLE reservations (space TEXT NOT NULL, sequence TEXT NOT NULL, value INTEGER NOT NULL, holder TEXT NOT NULL, abandoned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(space, sequence, value))",
    "CREATE TABLE intents (space TEXT NOT NULL, intent_id TEXT NOT NULL, session TEXT NOT NULL, principal TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, intent_id))",
    "CREATE TABLE branch_status (space TEXT NOT NULL, branch TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, branch))",
    "CREATE TABLE messages (space TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, seq))",
    "CREATE TABLE inbox_cursors (space TEXT NOT NULL, principal TEXT NOT NULL, cursor INTEGER NOT NULL, PRIMARY KEY(space, principal))",
    "CREATE TABLE policies (space TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE reachability (space TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(space, ref, sha))",
  ],
  [
    "CREATE TABLE asks (space TEXT NOT NULL, ask_id TEXT NOT NULL, asker TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, ask_id))",
    "CREATE TABLE decisions (space TEXT NOT NULL, decision_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, decision_id))",
  ],
  [
    "ALTER TABLE spaces ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0",
    "CREATE TABLE executors (space TEXT NOT NULL, env TEXT NOT NULL, epoch TEXT NOT NULL, max_fence INTEGER NOT NULL, PRIMARY KEY(space, env))",
    "CREATE TABLE deployments (space TEXT NOT NULL, env TEXT NOT NULL, op TEXT, exec_seq INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(space, seq), UNIQUE(space, op))",
    "CREATE INDEX deployments_order ON deployments(space, env, exec_seq DESC, seq DESC)",
  ],
  ["ALTER TABLE executors ADD COLUMN principal TEXT"],
  [
    "ALTER TABLE principals ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
    "UPDATE principals SET generation=1 WHERE revoked=1",
    "ALTER TABLE credentials ADD COLUMN device TEXT",
    "ALTER TABLE credentials ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0",
    "UPDATE credentials SET revoked=1 WHERE EXISTS (SELECT 1 FROM principals p WHERE p.space=credentials.space AND p.principal=credentials.principal AND p.revoked=1)",
    "CREATE UNIQUE INDEX credential_device ON credentials(space, principal, device, kind) WHERE revoked=0",
    "CREATE INDEX sessions_expiry ON sessions(closed, expires_at)",
    "ALTER TABLE intents ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(body, '$.state')) VIRTUAL",
    "ALTER TABLE intents ADD COLUMN expires INTEGER GENERATED ALWAYS AS (CAST(round(unixepoch(json_extract(body, '$.expires_at'), 'subsec') * 1000) AS INTEGER)) VIRTUAL",
    "CREATE INDEX intents_expiry ON intents(status, expires)",
    "ALTER TABLE asks ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(body, '$.state')) VIRTUAL",
    "ALTER TABLE asks ADD COLUMN expires INTEGER GENERATED ALWAYS AS (CAST(round(unixepoch(json_extract(body, '$.deadline'), 'subsec') * 1000) AS INTEGER)) VIRTUAL",
    "CREATE INDEX asks_expiry ON asks(status, expires)",
    "CREATE TABLE audit_checkpoints(space TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, xhash TEXT NOT NULL, PRIMARY KEY(space, epoch, seq))",
    "CREATE INDEX events_request ON events(space, json_extract(event, '$.request_id'))",
    "UPDATE receipts SET principal=principal || '/' || CASE WHEN EXISTS (SELECT 1 FROM events WHERE events.space=receipts.space AND json_extract(event, '$.request_id')=receipts.request_id AND json_extract(event, '$.actor.principal')=receipts.principal) THEN (SELECT json_extract(event, '$.actor.session') FROM events WHERE events.space=receipts.space AND json_extract(event, '$.request_id')=receipts.request_id AND json_extract(event, '$.actor.principal')=receipts.principal LIMIT 1) ELSE json_extract(response, '$.result.holder') END WHERE CASE WHEN EXISTS (SELECT 1 FROM events WHERE events.space=receipts.space AND json_extract(event, '$.request_id')=receipts.request_id AND json_extract(event, '$.actor.principal')=receipts.principal) THEN (SELECT json_extract(event, '$.actor.session') FROM events WHERE events.space=receipts.space AND json_extract(event, '$.request_id')=receipts.request_id AND json_extract(event, '$.actor.principal')=receipts.principal LIMIT 1) ELSE json_extract(response, '$.result.holder') END IS NOT NULL",
    "CREATE INDEX events_time ON events(space, json_extract(event, '$.recorded_at'), seq)",
    "CREATE INDEX decisions_seq ON decisions(space, seq)",
  ],
];
export function migrate(tx: SqlTx): void {
  tx.run("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)");
  const version = tx.get<{ version: number }>("SELECT MAX(version) AS version FROM migrations")?.version ?? 0;
  if (version > migrations.length) throw new Error("Database schema is newer than this build");
  for (let i = version; i < migrations.length; i++) {
    for (const sql of migrations[i]) tx.run(sql);
    tx.run("INSERT INTO migrations VALUES (?)", i + 1);
  }
}
