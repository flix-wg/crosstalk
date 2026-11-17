import { ClientError } from "../client/index.js";
import { exportOnce, verify } from "./index.js";
async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (rest.length || !["export", "verify"].includes(action ?? "")) throw new ClientError("usage", "xt audit export|verify");
  console.log(JSON.stringify(action === "export" ? await exportOnce(process.cwd()) : verify(process.cwd())));
}
main().catch((e: unknown) => { console.error(e instanceof ClientError ? e.code + ": " + e.message : "audit_failed: audit operation failed"); process.exitCode = 1; });
