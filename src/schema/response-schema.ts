import { commandArgsSchemas } from "./command-schema.js";
import { eventSchema } from "./event-schema.js";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required });
const array = (items: unknown) => ({ type: "array", items });
const def = (name: keyof typeof eventSchema.$defs) => ({ $ref: "event.json#/$defs/" + name });
const seq = { type: "integer", minimum: 0 };
const uuid = eventSchema.properties.space;
const text = { type: "string" };
const principal = eventSchema.properties.actor.properties.principal;
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const lease = eventSchema.$defs.lease.properties;
const response = (result: unknown) => object({ epoch: uuid, seq, result });
const presence = object({ session: uuid, principal, tool: text, device: text, doing: text,
  state: { enum: ["working", "waiting", "offline"] }, expires_at: { type: "integer" } });
const leaseView = object({ mode: lease.mode, lease_id: uuid, holder: uuid, resources: def("keys"), state: lease.state,
  fence: lease.fence, rev: lease.rev, note: orNull(lease.note), supersedes: lease.supersedes, expires_at: def("time"), expires_in_s: { type: "number", minimum: 0 } });
const live = object({ live_artifact: orNull(def("digest")), live_sha: orNull(def("oid")), exec_seq: seq });
const more = object(Object.fromEntries(["presence", "leases", "asks", "messages", "decisions", "deployments", "reservations"].map(key => [key, { type: "boolean" }])));
export const boardResponse = response(object({
  frozen: { type: "boolean" }, coordination: object({ branches: array(def("branch_status")), policy: commandArgsSchemas["policy.set"] }),
  presence: array(presence), leases: array(leaseView), asks: array(def("ask")), messages: array(def("message")), decisions: array(def("decision")),
  reservations: array(object({ sequence: text, value: seq, holder: uuid, abandoned: { enum: [0, 1] } })), more,
  deployments: array(def("deployment")), live: { type: "object", additionalProperties: live },
  audit: object({ head: def("hash"), exported_seq: seq, lag: seq }),
}, ["frozen", "coordination", "presence", "leases", "asks", "messages", "decisions", "reservations", "more"]));
export const inboxResponse = response(object({ cursor: seq, messages: array(object({ seq, body: def("message") })), asks: array(def("ask")) }));
export const identityResponse = response(object({ principal, kind: { enum: ["human", "agent", "ci"] },
  role: { enum: ["admin", "member", "ci"] }, session: uuid }, ["principal", "role", "kind"]));
