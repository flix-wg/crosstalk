import { eventSchema } from "./event-schema.js";
import { commandSchema } from "./command-schema.js";
import { sessionSchema, installSchema } from "./session-schema.js";
import { deployInputSchema, ticketSchema, gateSchema } from "./gate-schema.js";

export const PROTOCOL_VERSION = "1.0";
export const SCHEMA_BASE = "https://flix-wg.github.io/crosstalk/schema/";

type Schema = Record<string, unknown>;
const omit = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const document = (name: string, schema: Schema): Schema => {
  const body = omit(schema, ["$schema", "$id"]);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${SCHEMA_BASE}v1/${name}.json`, "x-crosstalk-version": PROTOCOL_VERSION, ...body };
};
// The relay adds space and now to the gate input; the wire body (POST /check) carries neither.
const wireGate = { oneOf: gateSchema.oneOf.map(({ properties, required, ...rest }) => {
  return { ...rest, properties: omit(properties, ["space", "now"]), required: required.filter(name => name !== "space" && name !== "now") };
}) };

/** The schema documents of protocol Appendix A, keyed by file name. */
export function publishedSchemas(): Record<string, Schema> {
  return {
    event: document("event", eventSchema),
    command: document("command", commandSchema),
    session: document("session", sessionSchema),
    install: document("install", installSchema),
    gate: document("gate", wireGate),
    deploy: document("deploy", { $defs: { request: deployInputSchema, ticket: ticketSchema }, oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/ticket" }] }),
  };
}
