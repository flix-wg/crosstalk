import { eventSchema } from "./event-schema.js";

const d = eventSchema.$defs;
const uuid = { type: "string", format: "uuid" };
const text = { type: "string", minLength: 1 };
const note = { type: "string", maxLength: 280 };
const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const ref = (name: keyof typeof d) => ({ $ref: `#/$defs/${name}` });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", additionalProperties: false, properties, required,
});
const ask = d.ask.properties;
const branch = d.branch_status.properties;
const env = d.deployment.properties.env;
const principal = eventSchema.properties.actor.properties.principal;
const verdict = { enum: ["pass", "warn", "block"] };

// Only command inputs belong here; actor, timestamps, revisions and fences are relay-derived.
export const commandArgsSchemas = {
  "intent.post": object({
    intent_id: uuid, summary: d.intent.properties.summary, resources: ref("keys"),
    reads: d.intent.properties.reads, ttl_s: { type: "integer", minimum: 1 },
  }, ["summary", "resources"]),
  "intent.close": object({ intent_id: uuid, state: { enum: ["done", "abandoned"] } }, ["intent_id"]),
  "lease.claim": object({
    resources: {
      ...d.keys,
      items: { allOf: [ref("key"), { not: { pattern: "^seq:" } }] },
      if: { contains: { type: "string", pattern: "^env:" } }, then: { maxItems: 1 },
    }, ttl_s: { type: "integer", minimum: 30, maximum: 900 }, note,
    expect: object({ lease_id: uuid, rev: { type: "integer", minimum: 1 } }, ["lease_id", "rev"]),
  }, ["resources"]),
  "session.release": object({ session: uuid }, ["session"]),
  "lease.release": object({ lease_id: uuid }, ["lease_id"]),
  reserve: object({
    sequence: { type: "string", pattern: "^seq:[a-z0-9][a-z0-9_-]*$" }, floor: counter, note,
    abandon: counter,
  }, ["sequence"]),
  "message.send": object({
    to: d.message.properties.to, context_id: uuid, parts: ref("parts"),
  }, ["to", "context_id", "parts"]),
  "inbox.ack": object({ cursor: counter }, ["cursor"]),
  "ask.open": {
    ...object({
      kind: ask.kind, to: ask.to, question: ask.question, options: ask.options,
      resources: ask.resources, blocks: ask.blocks, bound_head: ask.bound_head,
      bound_artifact: ask.bound_artifact, deadline: ask.deadline,
    }, ["kind", "to", "question"]),
    if: d.ask.if, then: d.ask.then,
  },
  "ask.cancel": object({ ask_id: uuid }, ["ask_id"]),
  "branch.set": object({
    branch: text, state: { enum: ["wip", "draft", "ready"] }, head: ref("oid"),
    note: branch.note, pending: branch.pending, owner: principal,
  }, ["branch", "state", "head"]),
  "ask.answer": object({
    ask_id: uuid, choice: d.answer.properties.choice, text: d.answer.properties.text,
    reaffirm: { type: "boolean" }, bound_head: ref("oid"), bound_artifact: ref("digest"),
  }, ["ask_id", "choice"]),
  "ask.withdraw": object({ ask_id: uuid, reason: note }, ["ask_id"]),
  "override.record": object({
    scope: d.decision.properties.scope, bound_head: ref("oid"),
    bound_artifact: ref("digest"), reason: { type: "string", minLength: 1, maxLength: 280 },
  }, ["scope", "bound_head", "reason"]),
  "deployment.record": object({
    env, sha: ref("oid"), artifact: ref("digest"), fence: { ...counter, minimum: 1 }, op: uuid,
    exec_seq: { ...counter, minimum: 1 }, live_after: d.deployment.properties.live_after,
    outcome: { enum: ["promoted", "failed", "reconciled"] },
  }, ["env", "sha", "artifact", "fence", "op", "exec_seq", "live_after", "outcome"]),
  "space.freeze": object({ reason: note }, []),
  "env.adopt": object({ env, sha: ref("oid"), artifact: ref("digest") }, ["env", "sha", "artifact"]),
  "executor.enroll": object({ env, executor: { ...principal, pattern: "^ci:[a-z0-9][a-z0-9-]{0,38}$" }, max_fence: counter }, ["env", "executor", "max_fence"]),
  "executor.reconcile": object({ env }, ["env"]),
  "lease.revoke": object({ lease_id: uuid, reason: { ...note, minLength: 1 } }, ["lease_id", "reason"]),
  "principal.invite": object({ principal, role: { enum: ["admin", "member", "ci"] } }, ["principal", "role"]),
  "principal.revoke": object({ principal, reason: note, device: { type: "string", minLength: 1, maxLength: 80 } }, ["principal"]),
  "space.unfreeze": object({ reason: note }, []),
  "policy.set": object({
    protected_branches: { type: "array", items: text, uniqueItems: true },
    gates: object({ merge: object({
      unknown: verdict, unknown_source: verdict, stale_ready: verdict,
    }, []) }, []),
    envs: { type: "object", additionalProperties: object({ require_on: text }, []) },
  }, []),
  "ref.seed": object({ ref: text, commits: { type: "array", items: { type: "string", pattern: d.oid.pattern }, uniqueItems: true } }, ["ref", "commits"]),
  "ref.advance": object({
    ref: text, old: ref("oid"), new: ref("oid"),
    commits: { type: "array", items: { type: "string", pattern: d.oid.pattern }, uniqueItems: true },
  }, ["ref", "old", "new", "commits"]),
};

export const commandSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://flix-wg.github.io/crosstalk/schema/v1/command.json",
  $defs: d,
  oneOf: Object.entries(commandArgsSchemas).map(([op, args]) => object({
    request_id: uuid, op: { const: op }, args,
    expect_rev: { type: "integer", minimum: 1 },
  }, ["request_id", "op", "args"])),
};
