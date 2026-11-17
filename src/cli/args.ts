import { ClientError } from "../client/index.js";
export class Args {
  readonly positional: string[] = [];
  private readonly flags = new Map<string, string[]>();
  constructor(argv: string[]) {
    const booleans = new Set(["json", "approval", "reaffirm", "unknown-source", "help", "local", "human"]);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg.startsWith("--")) { this.positional.push(arg); continue; }
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (booleans.has(name) && inline !== undefined && inline !== "true") throw new ClientError("usage", "Boolean flags do not accept a value: --" + name);
      const value = inline ?? (booleans.has(name) ? "true" : argv[++i]);
      if (value === undefined || value.startsWith("--")) throw new ClientError("usage", "Missing --" + name + " value");
      this.flags.set(name, [...(this.flags.get(name) ?? []), value]);
    }
  }
  take(name: string): string | undefined { const all = this.all(name); if (all.length > 1) throw new ClientError("usage", "Repeat only list flags: --" + name); return all[0]; }
  all(name: string): string[] { const values = this.flags.get(name) ?? []; this.flags.delete(name); return values; }
  need(name: string): string { const value = this.take(name); if (!value) throw new ClientError("usage", "Required: --" + name); return value; }
  number(name: string): number | undefined { const value = this.take(name); if (value === undefined) return; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new ClientError("usage", "Expected nonnegative integer: --" + name); return n; }
  pos(): string { const value = this.positional.shift(); if (!value) throw new ClientError("usage", "Missing command argument"); return value; }
  done(): void { if (this.flags.size || this.positional.length) throw new ClientError("usage", "Unexpected arguments: " + [...this.flags.keys()].map(k => "--" + k).join(", ")); }
}
