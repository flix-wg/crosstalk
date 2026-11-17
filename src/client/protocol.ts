import { PROTOCOL_VERSION } from "../schema/index.js";
import { ClientError } from "./config.js";

export function checkProtocol(response: Response): void {
  const version = response.headers.get("Crosstalk-Protocol");
  if (version !== null && version.split(".")[0] !== PROTOCOL_VERSION.split(".")[0])
    throw new ClientError("unsupported_version", "Relay protocol major is incompatible with client protocol " + PROTOCOL_VERSION);
}
