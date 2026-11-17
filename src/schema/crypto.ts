import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Event } from "./types.js";

/** RFC 8785 over JSON data. Reject non-JSON values instead of silently dropping them.
 * Input is already parsed: duplicate keys must be rejected by the caller's parser.
 */
export function jcs(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return "null";
    if (typeof input === "string") {
      if (/[\uD800-\uDFFF]/u.test(input)) throw new TypeError("JCS requires valid Unicode");
      return JSON.stringify(input);
    }
    if (typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object") throw new TypeError("JCS requires JSON data");
    if (ancestors.has(input)) throw new TypeError("JCS cannot encode cycles");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        return "[" + Array.from(input, (item) => encode(item)).join(",") + "]";
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new TypeError("JCS requires plain JSON objects");
      }
      const object = input as Record<string, unknown>;
      return "{" + Object.keys(object).sort().map((key) => encode(key) + ":" + encode(object[key])).join(",") + "}";
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

export const GENESIS_PREV_HASH = "sha256:" + "0".repeat(64);

/** Hash UTF-8 text concatenation, retaining prev_hash in the canonical envelope. */
export function eventHash(prevHash: string, event: Omit<Event, "hash"> | Event): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(prevHash) || event.prev_hash !== prevHash) {
    throw new TypeError("Event prev_hash must match the supplied SHA-256 hash");
  }
  const unsigned = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "hash"));
  return "sha256:" + createHash("sha256").update(prevHash, "utf8").update(jcs(unsigned), "utf8").digest("hex");
}

/** Sign exact bytes; callers choose the protocol's framing or JCS serialization. */
export function sign(data: string | Uint8Array, privateKey: KeyObject): Buffer {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("An Ed25519 private key is required");
  }
  return cryptoSign(null, typeof data === "string" ? Buffer.from(data, "utf8") : data, privateKey);
}

export function verify(data: string | Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("An Ed25519 public key is required");
  }
  return cryptoVerify(null, typeof data === "string" ? Buffer.from(data, "utf8") : data, publicKey, signature);
}

/** SHA-256 for credential secrets and canonical command payloads. */
export function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}
