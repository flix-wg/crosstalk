import { overlaps } from "../schema/index.js";
export const ASK_REMINDER = "Only the addressed human can answer these asks. The agent cannot answer.";
export function leaseHolder(holder: string, presence: { session: string; principal: string; tool?: string }[] = []): string {
  const peer = presence.find(p => p.session === holder);
  return peer ? `${peer.principal} (${peer.tool ?? "unknown"}, ${holder.slice(0, 8)})` : `unknown (unknown, ${holder.slice(0, 8)})`;
}
function displayLeases(board: Record<string, unknown>): unknown {
  const presence = board.presence as { session: string; principal: string; tool?: string }[] | undefined;
  return Array.isArray(board.leases) ? board.leases.map(l => ({ ...l, holder: leaseHolder(l.holder, presence) })) : board.leases;
}
/** Relevance changes presentation order only; the relay remains authoritative. */
export function relevantBoard(snapshot: unknown, branch: string | null, session?: string): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const board = snapshot as Record<string, unknown>;
  const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value : [];
  const principal = rows(board.presence).find(p => p.session === session)?.principal;
  const asks = rows(board.asks).toSorted((a, b) => Number(b.to === principal && b.state === "open") - Number(a.to === principal && a.state === "open"));
  const coordination = board.coordination as Record<string, unknown> | undefined;
  const branches = rows(coordination?.branches).toSorted((a, b) => Number(b.branch === branch) - Number(a.branch === branch));
  return { asks, coordination: { ...coordination, branches }, leases: displayLeases(board), presence: board.presence,
    ...Object.fromEntries(Object.entries(board).filter(([key]) => !["asks", "coordination", "leases", "presence"].includes(key))) };
}

/** Small hook digest, excluding unrelated message history and deployment data. */
export function hookDigest(snapshot: unknown, branch: string | null, session: string, touched: string[], messages?: unknown[]): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const board = snapshot as Record<string, unknown>;
  const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v : [];
  const presence = rows(board.presence), principal = presence.find(p => p.session === session)?.principal;
  const coordination = board.coordination as Record<string, unknown> | undefined;
  const policy = coordination?.policy as { protected_branches?: string[] } | undefined;
  const relevant = (r: unknown) => typeof r === "string" && ((branch !== null && overlaps(r, "branch:" + branch)) || touched.some(p => overlaps(r, "path:" + p)));
  const asks = rows(board.asks).filter(a => a.to === principal && a.state === "open");
  return {
    ...(asks.length ? { reminder: ASK_REMINDER } : {}),
    asks,
    ...(messages ? { messages } : {}),
    branches: rows(coordination?.branches)
      .filter(b => b.branch === branch || policy?.protected_branches?.includes(String(b.branch)) || ["draft", "wip"].includes(String(b.state)))
      .map(b => ({ branch: b.branch, state: b.state, owner: b.owner, pending: b.pending })),
    leases: rows(board.leases).filter(l => l.holder !== session && Array.isArray(l.resources) && l.resources.some(relevant) && ["held", "pending"].includes(String(l.state))).map(l => ({ ...l, holder: leaseHolder(String(l.holder), presence as { session: string; principal: string; tool?: string }[]) })),
    active: presence.filter(p => p.session !== session && p.state !== "offline"),
  };
}
