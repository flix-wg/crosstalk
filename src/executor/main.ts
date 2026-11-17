import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, requireHumanTTY, render } from "../client/index.js";
import { config, client, durable, execute, operations, state, readJSON, processGroup, signalGroup, lockGroups } from "./index.js";
import type { Lock } from "./index.js";
import type { SignedTicket } from "../schema/index.js";

async function main(): Promise<number> {
  const args = process.argv.slice(2), inside = args[0] === "--locked";
  if (inside) args.shift();
  const [action, env, ...rest] = args;
  if (!action || !env || !["status", "enroll", "install", "promote", "reconcile"].includes(action)) throw new ClientError("usage", "xt executor enroll|install|promote|reconcile|status <env>");
  const c = config(env), options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) { if (!["--lease", "--fence", "--ticket"].includes(rest[i]!) || rest[i + 1] === undefined || options.has(rest[i]!)) throw new ClientError("usage", "Invalid executor arguments"); options.set(rest[i]!, rest[i + 1]!); }
  if (action === "status") { console.log(JSON.stringify({ state: state(c), ops: operations(c), lock: existsSync(join(c.stateDir, "lock.json")) ? readJSON<Lock>(join(c.stateDir, "lock.json")) : null })); return 0; }
  if (action === "install" && (!/^[0-9a-f-]{36}$/i.test(options.get("--lease") ?? "") || !Number.isSafeInteger(Number(options.get("--fence"))) || Number(options.get("--fence")) < 1)) throw new ClientError("usage", "Install requires --lease UUID --fence positive-integer");
  if (!inside) {
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const invoke = (): Promise<number> => new Promise((resolve, reject) => {
      const p = spawn("flock", ["-E", "75", "-w", String(c.timeout_s + 10), join(c.stateDir, "lock"), process.execPath, fileURLToPath(import.meta.url), "--locked", ...args], { detached: true, stdio: "inherit" });
      p.once("error", reject); p.once("exit", code => resolve(code ?? 1));
    });
    let code = await invoke();
    if (code === 75) {
      const lock = existsSync(join(c.stateDir, "lock.json")) ? readJSON<Lock>(join(c.stateDir, "lock.json")) : undefined;
      const busy = { ...lock, age_s: lock ? (Date.now() - lock.since) / 1000 : null };
      if (action === "reconcile") {
        // lock.json can miss a child spawned just before a crash; /proc cannot.
        const groups = lockGroups(c);
        requireHumanTTY("Terminate busy executor process groups " + groups.join(", ") + ": " + render(busy, { peer: false }));
        // Rescan after the prompt and after each round: a holder can hand the lock to a new group meanwhile.
        // SIGSTOP first so nothing spawns between the scan and the kill.
        for (let round = 0; round < 5; round++) {
          const live = lockGroups(c);
          for (const g of live) signalGroup(g, "SIGSTOP");
          for (const g of lockGroups(c)) if (!live.includes(g)) { live.push(g); signalGroup(g, "SIGSTOP"); }
          for (const g of live) { signalGroup(g, "SIGTERM"); signalGroup(g, "SIGCONT"); }
          await sleep(round === 0 ? 10000 : 1000);
          for (const g of lockGroups(c)) if (live.includes(g)) signalGroup(g, "SIGKILL");
          groups.length = 0;
          await sleep(100);
          if (!lockGroups(c).length) break;
        }
        code = await invoke();
      } else {
        try { await client(c).send("message.send", { to: ["all"], context_id: lock?.op ?? randomUUID(), parts: [{ kind: "data", data: { code: "executor_busy", env, ...busy } }] }); } catch { console.error("executor_busy: busy notification could not be delivered"); }
        throw new ClientError("executor_busy", "Executor lock is busy", busy);
      }
    }
    return code;
  }
  // Confirm under the lock: a direct `--locked` call must not skip it. The detached
  // child has no controlling terminal, so it asks on the terminal it inherited.
  if (["enroll", "reconcile"].includes(action)) {
    let terminal: string | undefined;
    try { terminal = readlinkSync("/proc/self/fd/0"); } catch { /* No stdin. */ }
    if (!terminal || !/^\/dev\/(?:pts\/\d+|tty\w*)$/.test(terminal)) throw new ClientError("tty_required", "Executor " + action + " requires an interactive terminal");
    requireHumanTTY("Executor " + action + " " + env, terminal);
  }
  const lock: Lock = { pid: process.pid, pgid: processGroup(), since: Date.now() };
  durable(c, "lock.json", lock);
  const ticketPath = options.get("--ticket");
  const ticket = ticketPath ? JSON.parse(readFileSync(ticketPath === "-" ? 0 : ticketPath, "utf8")) as SignedTicket : undefined;
  const result = await execute(c, env, action, { lease: options.get("--lease"), fence: Number(options.get("--fence")), ticket }, lock);
  console.log(JSON.stringify(result)); return result && typeof result === "object" && "outcome" in result && result.outcome === "failed" ? 1 : 0;
}
main().then(code => { process.exitCode = code; }).catch((e: unknown) => { console.error(e instanceof ClientError ? e.code + ": " + e.message : "executor_failed: executor operation failed"); process.exitCode = 1; });
