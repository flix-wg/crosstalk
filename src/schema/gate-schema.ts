import { eventSchema } from "./event-schema.js";

const text = { type: "string", minLength: 1 };
const uuid = { type: "string", format: "uuid" };
const oid = { type: "string", pattern: eventSchema.$defs.oid.pattern };
const env = eventSchema.$defs.deployment.properties.env;
const counter = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
export const deployFields = {
  env, sha: oid, artifact: eventSchema.$defs.digest, lease_id: uuid, fence: counter, op: uuid,
};
export interface DeployInput { env: string; sha: string; artifact: string; lease_id: string; fence: number; op: string }
export interface TicketPayload extends DeployInput {
  kind: "deploy_ticket"; space: string; epoch: string; holder: string; principal: string; expires_at: number;
}
export interface SignedTicket { payload: TicketPayload; signature: string }
export const deployInputSchema = object(deployFields);
export const ticketSchema = object({
  payload: object({ ...deployFields, kind: { const: "deploy_ticket" }, space: uuid, epoch: uuid, holder: uuid,
    principal: eventSchema.properties.actor.properties.principal, expires_at: counter }),
  signature: { type: "string", minLength: 1 },
});
export type GateInput = { space: string; now: number } & (
  | ({ kind: "merge"; source_head: string; target_branch: string } & ({ source_branch: string; unknown_source?: false } | { source_branch?: string; unknown_source: true }))
  | { kind: "deploy"; env: string; sha: string; artifact: string; lease_id: string; fence: number; holder: string }
);
export const gateSchema = { oneOf: [
  object({ space: uuid, now: { type: "number" }, kind: { const: "merge" }, source_branch: text, source_head: oid, target_branch: text, unknown_source: { const: false } },
    ["space", "now", "kind", "source_branch", "source_head", "target_branch"]),
  object({ space: uuid, now: { type: "number" }, kind: { const: "merge" }, source_branch: text, source_head: oid, target_branch: text, unknown_source: { const: true } },
    ["space", "now", "kind", "source_head", "target_branch", "unknown_source"]),
  object({ space: uuid, now: { type: "number" }, kind: { const: "deploy" }, env, sha: oid, artifact: eventSchema.$defs.digest, lease_id: uuid, fence: counter, holder: uuid }),
] };
