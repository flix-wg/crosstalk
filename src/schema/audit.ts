import { GENESIS_PREV_HASH, jcs, sha256 } from "./crypto.js";
import type { Event } from "./types.js";
export type ExportLine = ({ x: "event"; event: Event } | { x: "skip"; from_seq: number; to_seq: number; count: number; last_hash: string }) & { xprev: string; xhash: string };
export interface AuditHead { space: string; epoch: string; through_seq: number; through_hash: string; xhash: string; relay_key: string; sig: string; exported_at: string }
export function auditSigningText(head: Pick<AuditHead, "space" | "epoch" | "through_seq" | "through_hash" | "xhash">): string { return head.space + head.epoch + head.through_seq + head.through_hash + head.xhash; }
export function exportable(event: Event, approvals: ReadonlySet<string>): boolean {
  const b = event.body;
  switch (b.type) {
    case "intent": case "message": return false;
    case "lease": return b.resources.some(r => r.startsWith("env:") || r.startsWith("branch:"));
    case "ask": return b.kind === "approval";
    case "answer": return approvals.has(b.ask_id);
    default: return true;
  }
}
export function exportHash(line: Omit<ExportLine, "xhash"> | ExportLine): string {
  const unsigned = Object.fromEntries(Object.entries(line).filter(([key]) => key !== "xhash"));
  return sha256(line.xprev + jcs(unsigned));
}
/** Single-event skip runs make the chain independent of pagination and export timing. */
export function exportLine(event: Event, xprev: string, approvals: ReadonlySet<string>): ExportLine {
  const line = exportable(event, approvals) ? { x: "event" as const, event, xprev } : { x: "skip" as const, from_seq: event.seq, to_seq: event.seq, count: 1, last_hash: event.hash, xprev };
  return { ...line, xhash: exportHash(line) };
}
export function exportChain(events: readonly Event[], xprev = GENESIS_PREV_HASH, approvals = new Set<string>()): ExportLine[] {
  const knownApprovals = new Set(approvals);
  return events.map(event => {
    if (event.body.type === "ask" && event.body.kind === "approval") knownApprovals.add(event.body.ask_id);
    const line = exportLine(event, xprev, knownApprovals); xprev = line.xhash; return line;
  });
}
