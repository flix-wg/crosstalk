#!/usr/bin/env node
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { startRelay, restoreDatabase } from "./index.js";
import type { RelayConfig } from "./index.js";

try {
  const argv = process.argv.slice(2);
  const [command, configFile, space] = argv;
  let config: RelayConfig;
  if (command === "serve" || command === "restore") {
    if (!configFile) throw new Error("usage");
    config = JSON.parse(readFileSync(configFile, "utf8")) as RelayConfig;
  } else {
    const flags = new Map<string, string>();
    for (let i = command === "fingerprint" ? 1 : 0; i < argv.length; i += 2) {
      if (!["--db", "--port", "--host", "--operator-key-file"].includes(argv[i]) || !argv[i + 1]) throw new Error("usage");
      flags.set(argv[i], argv[i + 1]);
    }
    const database = flags.get("--db") ?? "crosstalk.sqlite";
    const port = Number(flags.get("--port") ?? 7331);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port");
    config = { database, port, host: flags.get("--host"), signingKeyFile: database + ".key", ...(flags.has("--operator-key-file") ? { operatorKey: readFileSync(flags.get("--operator-key-file")!, "utf8").trim() } : {}) };
  }
  if (command === "fingerprint") {
    const publicKey = createPublicKey(readFileSync(config.signingKeyFile)).export({ type: "spki", format: "der" });
    console.log("sha256:" + createHash("sha256").update(publicKey).digest("hex"));
  } else if (command === "restore") {
    if (!space) throw new Error("space required");
    restoreDatabase(config.database, space);
    console.log("Space restored and frozen");
  } else {
    const relay = await startRelay(config);
    console.log("Relay listening at " + relay.url);
    console.log("Relay fingerprint sha256:" + createHash("sha256").update(createPublicKey(readFileSync(config.signingKeyFile)).export({ type: "spki", format: "der" })).digest("hex"));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void relay.close(); });
  }
} catch {
  console.error("Relay failed. Usage: crosstalk-relay [--db <path>] [--host <host>] [--port <port>] [--operator-key-file <path>] | fingerprint --db <path> (existing relay) | serve <config.json> | restore <config.json> <space>");
  process.exitCode = 1;
}
