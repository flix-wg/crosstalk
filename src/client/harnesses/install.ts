import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
export function save(file: string, value: string) { mkdirSync(dirname(file), { recursive: true }); const temp = file + "." + randomUUID(); writeFileSync(temp, value); renameSync(temp, file); }
export function json(file: string): Record<string, unknown> { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {}; }

/** Shared installer for the two verified JSON hook formats. */
export function installJSONHooks(cwd: string, harness: string, { file: settingsFile, events, mcp, notice }: {
  file: string; events: Record<string, { matcher?: string }>; mcp(cwd: string): void; notice: string;
}): string {
  const file = join(cwd, settingsFile);
  const settings = json(file), hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, settings] of Object.entries(events)) {
    const command = `xt hook ${harness} ${event}`;
    const entries = hooks[event] ?? [];
    const entry = { ...settings, hooks: [{ type: "command", command, timeout: 5 }] };
    let replaced = false;
    for (let i = 0; i < entries.length; i++) {
      const existing = entries[i] as { hooks?: { command?: string }[] };
      if (!existing.hooks?.some(h => h.command === command)) continue;
      const others = existing.hooks.filter(h => h.command !== command);
      if (others.length) {
        entries[i] = { ...existing, hooks: others };
        if (!replaced) entries.splice(i++, 0, entry);
        replaced = true; continue;
      }
      entries.splice(i, 1, ...(replaced ? [] : [entry]));
      if (replaced) i--;
      replaced = true;
    }
    if (!replaced) entries.push(entry);
    hooks[event] = entries;
  }
  mcp(cwd);
  save(file, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
  return "Each new git worktree needs its own xt install. " + notice;
}
