import { deploySchema, wireGateSchema, gateSchema } from "./gate-schema.js";
import type { DeployInput, SignedTicket, GateInput } from "./gate-schema.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { eventSchema } from "./event-schema.js";
import { commandSchema, commandArgsSchemas } from "./command-schema.js";
import { sessionSchema, installSchema } from "./session-schema.js";
import type { SessionInput, InstallInput } from "./session-schema.js";
import type { Command, Event } from "./types.js";

// The verbatim spec uses type-less conditional subschemas (e.g. ask.then.blocks).
// Keep other strict checks, but allow those refinements.
const ajv = new Ajv2020({ allErrors: true, strictTypes: false, formats: fullFormats });
ajv.addSchema(deploySchema);
export const validateWireGate = lazy<unknown>(wireGateSchema);
// Short-lived hooks need only a subset; compile each schema on its first use.
function lazy<T>(schema: AnySchema) {
  let compiled: ValidateFunction<T> | undefined;
  const validate = (data: unknown): data is T => {
    compiled ??= ajv.compile<T>(schema);
    const valid = compiled(data);
    validate.errors = compiled.errors;
    return valid;
  };
  validate.errors = undefined as ErrorObject[] | null | undefined;
  return validate;
}
export const validateEvent = lazy<Event>(eventSchema);
export const validateCommand = lazy<Command>(commandSchema);
const argValidators = new Map<string, ReturnType<typeof ajv.compile>>();
/** Errors for one operation's args only; the union schema also reports every other operation's requirements. */
export function commandArgErrors(op: keyof typeof commandArgsSchemas, args: unknown) {
  let validate = argValidators.get(op);
  if (!validate) argValidators.set(op, validate = ajv.compile({ ...commandArgsSchemas[op], $defs: eventSchema.$defs }));
  return validate(args) ? [] : validate.errors ?? [];
}

export const validateSession = lazy<SessionInput>(sessionSchema);
export const validateInstall = lazy<InstallInput>(installSchema);

export const validateDeployInput = lazy<DeployInput>({ $ref: deploySchema.$id + "#/$defs/request" });
export const validateTicket = lazy<SignedTicket>({ $ref: deploySchema.$id + "#/$defs/ticket" });
export const validateGate = lazy<GateInput>(gateSchema);

// Strip only a copy: the original (including future fields) is hash-chain data.
type ReceiverSchema = { enum?: readonly unknown[]; type?: string | readonly string[]; $ref?: string; properties?: Record<string, ReceiverSchema>; items?: ReceiverSchema; oneOf?: readonly ReceiverSchema[]; const?: unknown; additionalProperties?: boolean | ReceiverSchema };
const definitions = eventSchema.$defs as Record<string, ReceiverSchema>;
function receiverCopy(value: unknown, schema: ReceiverSchema): unknown {
  if (schema.$ref) return receiverCopy(value, definitions[schema.$ref.slice("#/$defs/".length)]!);
  if (Array.isArray(value)) return schema.items ? value.map(item => receiverCopy(item, schema.items!)) : value;
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (schema.oneOf) {
    const variant = schema.oneOf.find(candidate => {
      const resolved = candidate.$ref ? definitions[candidate.$ref.slice("#/$defs/".length)]! : candidate;
      return Object.entries(resolved.properties ?? {}).some(([key, field]) => field.const !== undefined && object[key] === field.const);
    });
    return variant ? receiverCopy(value, variant) : value;
  }
  return Object.fromEntries(Object.entries(object).filter(([key]) => schema.additionalProperties !== false || Object.hasOwn(schema.properties ?? {}, key))
    .map(([key, item]) => [key, schema.properties?.[key] ? receiverCopy(item, schema.properties[key]) : item]));
}
const receiverAjv = new Ajv2020({ allErrors: true, strictTypes: false, formats: fullFormats });
const receiverValidators = new Map<string, ValidateFunction>();
/** Accept future members and body types, without weakening producer validation. */
export function validateEventTolerant(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("body" in value) || !value.body || typeof value.body !== "object" || !("type" in value.body) || typeof value.body.type !== "string") return false;
  const type = value.body.type;
  const known = eventSchema.properties.body.oneOf.some(ref => definitions[ref.$ref.slice("#/$defs/".length)]?.properties?.type?.const === type);
  const key = known ? type : "unknown";
  let validate = receiverValidators.get(key);
  if (!validate) {
    const schema = { ...eventSchema, $id: undefined,
      $defs: { ...eventSchema.$defs,
        admin: { ...eventSchema.$defs.admin, properties: { ...eventSchema.$defs.admin.properties, action: { type: "string" } } },
        parts: { ...eventSchema.$defs.parts, items: { oneOf: [...eventSchema.$defs.parts.items.oneOf,
          { type: "object", required: ["kind"], properties: { kind: { type: "string", not: { enum: ["text", "data"] } } } }], } },
      }, properties: { ...eventSchema.properties,
      body: known ? { $ref: "#/$defs/" + type } : { type: "object", required: ["type"], properties: { type: { type: "string" } } },
    } };
    validate = receiverAjv.compile(schema);
    receiverValidators.set(key, validate);
  }
  return validate(receiverCopy(value, eventSchema));
}
