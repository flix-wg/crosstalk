import { createHash, createPublicKey } from "node:crypto";
import { verify } from "../schema/index.js";

/** Pins are SHA-256 hex of SPKI DER, or ed25519: followed by the raw public key in base64. */
export function verifyRelaySignature(pin: string, publicKey: string, data: string | Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return false;
    const der = key.export({ format: "der", type: "spki" });
    const matches = pin.startsWith("sha256:")
      ? pin === "sha256:" + createHash("sha256").update(der).digest("hex")
      : pin.startsWith("ed25519:") && Buffer.from(pin.slice(8), "base64").equals(der.subarray(-32));
    return matches && verify(data, Buffer.from(signature, "base64"), key);
  } catch { return false; }
}
