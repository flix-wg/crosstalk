// Protocol Appendix A event schema. Keep wire-schema changes in sync with types.ts and docs/protocol.md.
export const eventSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://flix-wg.github.io/crosstalk/schema/v2/event.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "space", "epoch", "seq", "id", "request_id", "recorded_at", "actor", "git", "prev_hash", "hash", "body"],
  "properties": {
    "v": {"const": 2},
    "space": {"type": "string", "format": "uuid"},
    "epoch": {"type": "string", "format": "uuid"},
    "seq": {"type": "integer", "minimum": 1},
    "id": {"type": "string", "format": "uuid"},
    "request_id": {"type": ["string", "null"], "format": "uuid"},
    "recorded_at": {"$ref": "#/$defs/time"},
    "actor": {
      "type": "object", "additionalProperties": false,
      "required": ["principal", "via"],
      "properties": {
        "principal": {"type": "string", "pattern": "^(human|ci):[a-z0-9][a-z0-9-]{0,38}$"},
        "session": {"type": ["string", "null"], "format": "uuid"},
        "tool": {"type": "string", "pattern": "^[a-z][a-z0-9-]{0,31}$"},
        "via": {"enum": ["agent", "human-tty", "ci", "relay"]}
      }
    },
    "git": {
      "type": "object", "additionalProperties": false,
      "required": ["branch", "head"],
      "properties": {
        "branch": {"type": ["string", "null"]},
        "head": {"$ref": "#/$defs/oid"}
      }
    },
    "prev_hash": {"$ref": "#/$defs/hash"},
    "hash": {"$ref": "#/$defs/hash"},
    "body": {"oneOf": [
      {"$ref": "#/$defs/branch_status"},
      {"$ref": "#/$defs/lease"}, {"$ref": "#/$defs/reservation"},
      {"$ref": "#/$defs/message"}, {"$ref": "#/$defs/ask"},
      {"$ref": "#/$defs/answer"}, {"$ref": "#/$defs/decision"},
      {"$ref": "#/$defs/deployment"}, {"$ref": "#/$defs/admin"}
    ]}
  },
  "$defs": {
    "time": {"type": "string", "format": "date-time"},
    "hash": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "digest": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "oid": {"type": ["string", "null"], "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$"},
    "text": {"type": "string", "minLength": 1, "maxLength": 4096},
    "key": {"type": "string", "maxLength": 512,
            "pattern": "^(path:[^/].*[^/]|path:[^/]|tree:[^/].*/|branch:\\S+|env:[a-z0-9][a-z0-9-]*|res:\\S+|seq:[a-z0-9][a-z0-9_-]*)$"},
    "keys": {"type": "array", "items": {"$ref": "#/$defs/key"}, "minItems": 1, "maxItems": 64, "uniqueItems": true},
    "parts": {
      "type": "array", "minItems": 1, "maxItems": 8,
      "items": {"oneOf": [
        {"type": "object", "required": ["kind", "text"], "additionalProperties": false,
         "properties": {"kind": {"const": "text"}, "text": {"$ref": "#/$defs/text"}}},
        {"type": "object", "required": ["kind", "data"], "additionalProperties": false,
         "properties": {"kind": {"const": "data"}, "data": {"type": "object"}}}
      ]}
    },
    "branch_status": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "branch", "state", "head", "owner", "rev"],
      "properties": {
        "type": {"const": "branch_status"}, "branch": {"type": "string"},
        "state": {"enum": ["wip", "draft", "ready"]},
        "head": {"$ref": "#/$defs/oid"}, "owner": {"type": "string"},
        "note": {"type": "string", "maxLength": 280},
        "pending": {"type": "array", "items": {"type": "string", "maxLength": 140}, "maxItems": 10},
        "rev": {"type": "integer", "minimum": 1}
      }
    },
    "lease": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "lease_id", "mode", "op", "state", "resources", "holder", "fence", "rev", "expires_at"],
      "properties": {
        "type": {"const": "lease"}, "mode": {"enum": ["exclusive", "shared"]}, "lease_id": {"type": "string", "format": "uuid"},
        "op": {"enum": ["acquire", "install", "release", "expire", "revoke"]},
        "state": {"enum": ["pending", "held", "released", "expired", "revoked"]},
        "resources": {"$ref": "#/$defs/keys"},
        "holder": {"type": "string", "format": "uuid"},
        "fence": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
        "rev": {"type": "integer", "minimum": 1},
        "note": {"type": "string", "maxLength": 280},
        "supersedes": {"anyOf": [{"type": ["string", "null"], "format": "uuid"}, {"type": "array", "items": {"type": "string", "format": "uuid"}, "minItems": 2, "uniqueItems": true}]},
        "expires_at": {"$ref": "#/$defs/time"}
      }
    },
    "reservation": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "sequence", "value", "holder"],
      "properties": {
        "type": {"const": "reservation"}, "sequence": {"type": "string"},
        "value": {"type": "integer", "minimum": 0}, "holder": {"type": "string"},
        "note": {"type": "string", "maxLength": 280}
      }
    },
    "message": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "message_id", "to", "context_id", "parts"],
      "properties": {
        "type": {"const": "message"}, "message_id": {"type": "string", "format": "uuid"},
        "to": {"type": "array", "minItems": 1, "maxItems": 16, "uniqueItems": true,
               "items": {"type": "string", "pattern": "^(human:[a-z0-9-]+|ci:[a-z0-9-]+|session:[0-9a-f-]{36}|all)$"}},
        "context_id": {"type": "string", "format": "uuid"},
        "parts": {"$ref": "#/$defs/parts"}
      }
    },
    "ask": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "ask_id", "rev", "kind", "to", "question", "state"],
      "properties": {
        "type": {"const": "ask"}, "ask_id": {"type": "string", "format": "uuid"},
        "rev": {"type": "integer", "minimum": 1},
        "kind": {"enum": ["question", "approval"]},
        "to": {"type": "string", "pattern": "^human:[a-z0-9][a-z0-9-]{0,38}$"},
        "question": {"$ref": "#/$defs/text"},
        "options": {"type": "array", "items": {"type": "string", "maxLength": 80}, "maxItems": 8, "uniqueItems": true},
        "resources": {"type": "array", "items": {"$ref": "#/$defs/key"}, "maxItems": 16},
        "blocks": {"type": "array", "maxItems": 8,
                   "items": {"type": "string", "pattern": "^(merge:(branch|target):\\S+|deploy:env:[a-z0-9-]+)$"}},
        "bound_head": {"$ref": "#/$defs/oid"},
        "bound_artifact": {"$ref": "#/$defs/digest"},
        "state": {"enum": ["open", "answered", "withdrawn"]},
        "deadline": {"$ref": "#/$defs/time"}
      },
      "if": {"properties": {"kind": {"const": "question"}}},
      "then": {"properties": {"blocks": {"maxItems": 0}}}
    },
    "answer": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "ask_id", "answer_id"],
      "properties": {
        "type": {"const": "answer"}, "ask_id": {"type": "string", "format": "uuid"},
        "answer_id": {"type": "string", "format": "uuid"},
        "choice": {"type": "string", "maxLength": 80},
        "text": {"type": "string", "maxLength": 4096}
      }
    },
    "decision": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "decision_id", "source", "verdict", "bound_head", "decided_by"],
      "properties": {
        "type": {"const": "decision"}, "decision_id": {"type": "string", "format": "uuid"},
        "source": {"type": "object", "required": ["kind", "id"],
                   "properties": {"kind": {"enum": ["ask", "override"]}, "id": {"type": "string", "format": "uuid"}}},
        "verdict": {"enum": ["approve", "reject"]},
        "scope": {"type": "array", "minItems": 1, "items": {"type": "string"}},
        "bound_head": {"$ref": "#/$defs/oid"},
        "bound_artifact": {"$ref": "#/$defs/digest"},
        "rationale": {"type": "string", "maxLength": 4096},
        "decided_by": {"type": "string", "pattern": "^human:[a-z0-9-]+$"}
      }
    },
    "deployment": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "env", "sha", "artifact", "op", "exec_seq", "outcome", "live_after"],
      "properties": {
        "type": {"const": "deployment"}, "env": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$"},
        "sha": {"$ref": "#/$defs/oid"}, "artifact": {"$ref": "#/$defs/digest"},
        "fence": {"type": ["integer", "null"], "minimum": 1},
        "op": {"type": ["string", "null"], "format": "uuid"},
        "exec_seq": {"type": ["integer", "null"], "minimum": 0},
        "live_after": {"anyOf": [{"$ref": "#/$defs/digest"}, {"type": "null"}]},
        "outcome": {"enum": ["promoted", "failed", "reconciled", "adopted"]}
      }
    },
    "admin": {
      "type": "object", "additionalProperties": false,
      "required": ["type", "action"],
      "properties": {
        "type": {"const": "admin"},
        "action": {"enum": ["principal_enrolled", "principal_revoked", "epoch_started", "gates_frozen", "gates_unfrozen", "requirement_withdrawn", "override_recorded", "executor_enrolled", "lease_installed", "policy_set", "ref_seeded"]},
        "subject": {"type": "string"}, "reason": {"type": "string", "maxLength": 280}
      }
    }
  }
} as const;
