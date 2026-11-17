import { execFileSync } from "node:child_process";
import { openSync, closeSync, readSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { ClientError } from "./config.js";

/** Uses the controlling terminal, never redirected stdin. Exported for pty tests. */
export function readTerminal(prompt: string, secret = false, path = "/dev/tty"): string {
  let fd: number;
  try { fd = openSync(path, "r+"); }
  catch { throw new ClientError("tty_required", "This human-only command requires an interactive controlling terminal (/dev/tty)"); }
  try {
    if (!isatty(fd)) throw new ClientError("tty_required", "An interactive terminal is required");
    if (secret) execFileSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] });
    writeSync(fd, prompt);
    const bytes: number[] = [], byte = Buffer.alloc(1);
    while (readSync(fd, byte, 0, 1, null)) {
      if (byte[0] === 10) return Buffer.from(bytes).toString("utf8").trim();
      bytes.push(byte[0]);
      if (bytes.length > 4096) break;
    }
    throw new ClientError("confirmation_refused", "Terminal input was not completed");
  } finally {
    if (secret) { execFileSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] }); writeSync(fd, "\n"); }
    closeSync(fd);
  }
}
/** `path` lets a process without a controlling terminal (setsid) confirm on its inherited terminal. */
export function requireHumanTTY(action: string, path?: string): void {
  if (readTerminal(action + '\nType "confirm" to continue: ', false, path) !== "confirm")
    throw new ClientError("confirmation_refused", "Confirmation refused");
}
