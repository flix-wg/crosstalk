import { deployInputSchema, ticketSchema, gateSchema } from "./gate-schema.js";
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

export const validateDeployInput = lazy<DeployInput>(deployInputSchema);
export const validateTicket = lazy<SignedTicket>(ticketSchema);
export const validateGate = lazy<GateInput>(gateSchema);
