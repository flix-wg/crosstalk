// Types mirror the protocol event schema (Appendix A); runtime constraints are enforced by Ajv.
export type Time = string;

export type Hash = string;

export type Digest = string;

export type Oid = string | null;

export type Text = string;

export type Key = string;

export type Keys = (Key)[];

export type Parts = ({
  "kind": "text";
  "text": Text;
} | {
  "kind": "data";
  "data": Record<string, unknown>;
})[];

export type BranchStatus = {
  "type": "branch_status";
  "branch": string;
  "state": "wip" | "draft" | "ready";
  "head": Oid;
  "owner": string;
  "note"?: string;
  "pending"?: (string)[];
  "rev": number;
};

export type Lease = {
  "type": "lease";
  mode: "exclusive" | "shared";
  "lease_id": string;
  "op": "acquire" | "install" | "release" | "expire" | "revoke";
  "state": "pending" | "held" | "released" | "expired" | "revoked";
  "resources": Keys;
  "holder": string;
  "fence": number;
  "rev": number;
  "note"?: string;
  "supersedes"?: string | string[] | null;
  "expires_at": Time;
};

export type Reservation = {
  "type": "reservation";
  "sequence": string;
  "value": number;
  "holder": string;
  "note"?: string;
};

export type Message = {
  "type": "message";
  "message_id": string;
  "to": (string)[];
  "context_id": string;
  "parts": Parts;
};

export type Ask = {
  "type": "ask";
  "ask_id": string;
  "rev": number;
  "kind": "question" | "approval";
  "to": string;
  "question": Text;
  "options"?: (string)[];
  "resources"?: (Key)[];
  "blocks"?: (string)[];
  "bound_head"?: Oid;
  "bound_artifact"?: Digest;
  "state": "open" | "answered" | "withdrawn";
  "deadline"?: Time;
};

export type Answer = {
  "type": "answer";
  "ask_id": string;
  "answer_id": string;
  "choice"?: string;
  "text"?: string;
};

export type Decision = {
  "type": "decision";
  "decision_id": string;
  "source": {
  "kind": "ask" | "override";
  "id": string;
  [key: string]: unknown;
};
  "verdict": "approve" | "reject";
  "scope"?: (string)[];
  "bound_head": Oid;
  "bound_artifact"?: Digest;
  "rationale"?: string;
  "decided_by": string;
};

export type Deployment = {
  "type": "deployment";
  "env": string;
  "sha": Oid;
  "artifact": Digest;
  "fence"?: number | null;
  "op": string | null;
  "exec_seq": number | null;
  "live_after": Digest | null;
  "outcome": "promoted" | "failed" | "reconciled" | "adopted";
};

export type Admin = {
  "type": "admin";
  "action": "principal_enrolled" | "principal_revoked" | "epoch_started" | "gates_frozen" | "gates_unfrozen" | "requirement_withdrawn" | "override_recorded" | "executor_enrolled" | "lease_installed" | "policy_set" | "ref_seeded";
  "subject"?: string;
  "reason"?: string;
};

export type Event = {
  "v": 2;
  "space": string;
  "epoch": string;
  "seq": number;
  "id": string;
  "request_id": string | null;
  "recorded_at": Time;
  "actor": {
  "principal": string;
  "session"?: string | null;
  "tool"?: string;
  "via": "agent" | "human-tty" | "ci" | "relay";
};
  "git": {
  "branch": string | null;
  "head": Oid;
};
  "prev_hash": Hash;
  "hash": Hash;
  "body": BranchStatus | Lease | Reservation | Message | Ask | Answer | Decision | Deployment | Admin;
};

export interface CommandArgs {
  "lease.claim": { mode?: Lease["mode"]; resources: string[]; ttl_s?: number; note?: string; expect?: { lease_id: string; rev: number } };
  "lease.release": { lease_id: string };
  "session.release": { session: string };
  reserve: { sequence: string; floor?: number; note?: string; abandon?: number };
  "message.send": Pick<Message, "to" | "context_id" | "parts">;
  "inbox.ack": { cursor: number };
  "ask.open": Pick<Ask, "kind" | "to" | "question" | "options" | "resources" | "blocks" | "bound_head" | "bound_artifact" | "deadline">;
  "branch.set": Pick<BranchStatus, "branch" | "head" | "note" | "pending"> & { state: "wip" | "draft" | "ready"; owner?: string };
  "ask.answer": { ask_id: string; choice: string; text?: string; bound_head?: Oid; bound_artifact?: Digest };
  "ask.withdraw": { ask_id: string; reason?: string };
  "override.record": { scope: string[]; bound_head: Oid; bound_artifact?: Digest; reason: string };
  "deployment.record": DeploymentReport;
  "space.freeze": { reason?: string };
  "env.adopt": Pick<Deployment, "env" | "sha" | "artifact">;
  "executor.enroll": { executor: string; env: string; max_fence: number };
  "lease.revoke": { lease_id: string; reason: string };
  "principal.invite": { principal: string; role: "admin" | "member" | "ci" };
  "principal.revoke": { principal: string; reason?: string; device?: string };
  "space.unfreeze": { reason?: string };
  "policy.set": {
    sequences?: Record<string, string>;
    protected_branches?: string[];
    gates?: { merge?: { unknown?: GatePolicy; unknown_source?: GatePolicy; stale_ready?: GatePolicy } };
    envs?: Record<string, { require_on?: string }>;
  };
  "ref.seed": { ref: string; commits: string[] };
  "ref.advance": { ref: string; old: Oid; new: Oid; commits: string[] };
}
export type GatePolicy = "pass" | "warn" | "block";
export type Command = {
  [Op in keyof CommandArgs]: { request_id: string; op: Op; args: CommandArgs[Op]; expect_rev?: number };
}[keyof CommandArgs];
export type Payload = Event["body"];

export type DeploymentReport = Omit<Deployment, "type" | "op" | "exec_seq" | "outcome" | "fence"> & { fence: number; op: string; exec_seq: number; outcome: "promoted" | "failed" | "reconciled" };
