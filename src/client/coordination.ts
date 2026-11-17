import { leaseHolder } from "./presentation.js";
import { overlaps } from "../schema/index.js";
import type { BranchStatus } from "../schema/index.js";
export interface CoordinationBoard {
  presence?: { session: string; principal: string; tool?: string }[];
  leases: { mode?: "exclusive" | "shared"; lease_id: string; holder: string; resources: string[]; state: string; expires_at: string; expires_in_s?: number }[];
  coordination: { branches: BranchStatus[]; policy?: { sequences?: Record<string, string>; protected_branches?: string[] } };
}
export function editConflicts(board: CoordinationBoard, paths: string[], session?: string) {
  return board.leases.filter(l => l.holder !== session && ["held", "pending"].includes(l.state) && Date.parse(l.expires_at) > Date.now() &&
    l.resources.some(r => /^(path|tree):/.test(r) && paths.some(p => overlaps(r, "path:" + p)))).map(l => ({ ...l, holder: leaseHolder(l.holder, board.presence) }));
}
