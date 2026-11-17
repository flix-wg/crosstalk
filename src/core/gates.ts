import { validateGate } from "../schema/index.js";
import type { Ask, BranchStatus, Decision, Deployment, GateInput, GatePolicy } from "../schema/index.js";
import type { SqlTx } from "./types.js";
import type { LeaseRow } from "./leases.js";
import { refName } from "./coordination.js";
import type { Policy } from "./coordination.js";

export interface GateResult { verdict: GatePolicy; reasons: string[]; contacts: string[]; code?: "frozen" | "invalid_request" }
type Snapshot = Pick<SqlTx, "all" | "get">;
export function liveState(tx: Snapshot, space: string, env: string): { live_artifact: string | null; live_sha: string | null; exec_seq: number } | undefined {
  const rows = tx.all<{ body: string; exec_seq: number }>("SELECT body, exec_seq FROM deployments WHERE space=? AND env=? ORDER BY exec_seq DESC, seq DESC", space, env);
  if (!rows.length) return undefined;
  const latest = JSON.parse(rows[0].body) as Deployment;
  let sha = latest.live_after !== null && latest.live_after === latest.artifact ? latest.sha : null;
  if (latest.live_after !== latest.artifact && latest.live_after !== null) {
    const earlier = rows.slice(1).map(row => JSON.parse(row.body) as Deployment).find(body => body.artifact === latest.live_after);
    sha = earlier?.sha ?? null;
  }
  return { live_artifact: latest.live_after, live_sha: sha, exec_seq: rows[0].exec_seq };
}
/** Read-only gate evaluation. Time is explicit; no expiry writes or external calls. */
export function evaluateGate(tx: Snapshot, input: GateInput): GateResult {
  const result = (verdict: GatePolicy, reason?: string, contacts: string[] = []): GateResult => ({ verdict, reasons: reason ? [reason] : [], contacts });
  if (!validateGate(input)) return { ...result("block", "Invalid gate input"), code: "invalid_request" };
  if (tx.get<{ frozen: number }>("SELECT frozen FROM spaces WHERE space=?", input.space)?.frozen) return { ...result("block", "Space is frozen"), code: "frozen" };
  const raw = tx.get<{ body: string }>("SELECT body FROM policies WHERE space=?", input.space);
  const policy = raw ? JSON.parse(raw.body) as Policy : {};
  const decisions = tx.all<{ body: string }>("SELECT body FROM decisions WHERE space=? ORDER BY seq DESC", input.space).map(row => JSON.parse(row.body) as Decision);
  const scope = input.kind === "merge" ? "merge:branch:" + input.source_branch : "deploy:env:" + input.env;
  const head = input.kind === "merge" ? input.source_head : input.sha;
  const requirement = () => {
    const asks = tx.all<{ body: string }>("SELECT body FROM asks WHERE space=?", input.space).map(row => JSON.parse(row.body) as Ask);
    for (const ask of asks) {
      if (ask.kind !== "approval" || ask.state === "withdrawn" || !ask.blocks?.includes(scope)) continue;
      const d = decisions.find(d => d.source.kind === "ask" && d.source.id === ask.ask_id);
      const satisfied = ask.state === "answered" && d && d.decided_by === ask.to &&
        d.verdict === "approve" && d.bound_head === head && (input.kind === "merge" || d.bound_artifact === input.artifact);
      if (!satisfied) return result("block", "Waiting for " + ask.to + ": " + ask.question, [ask.to]);
    }
    return undefined;
  };
  if (input.kind === "merge") {
    const blocked = requirement();
    if (blocked) return blocked;
    const overrideScope = input.unknown_source ? "merge:target:" + input.target_branch : scope;
    const override = decisions.some(d => d.source.kind === "override" && d.verdict === "approve" && d.scope?.includes(overrideScope) && d.bound_head === head);
    if (input.unknown_source) {
      const verdict = policy.gates?.merge?.unknown_source ?? "block";
      return result(override ? "pass" : verdict, override ? "Human override" : "Unknown merge source");
    }
    const row = tx.get<{ body: string }>("SELECT body FROM branch_status WHERE space=? AND branch=?", input.space, input.source_branch);
    const status = row ? JSON.parse(row.body) as BranchStatus : undefined;
    let verdict: GatePolicy, reason: string;
    if (!status) { verdict = policy.gates?.merge?.unknown ?? "warn"; reason = "No branch status; publish branch_status ready at the exact head before merging (a merge or new commit changes the head)"; }
    else if (status.state === "draft" || status.state === "wip") { verdict = "block"; reason = status.owner + ": " + status.state + (status.pending?.length ? " — " + status.pending.join(", ") : ""); }
    else if (status.head === input.source_head) { verdict = "pass"; reason = "Ready at source head"; }
    else { verdict = policy.gates?.merge?.stale_ready ?? "warn"; reason = "Ready status is for another head"; }
    if (verdict === "block" && override) return result("pass", "Human override", status ? [status.owner] : []);
    return result(verdict, reason, status ? [status.owner] : []);
  }
  const lease = tx.get<LeaseRow>("SELECT * FROM leases WHERE space=? AND lease_id=?", input.space, input.lease_id);
  if (!lease || lease.state !== "held" || lease.expires_at <= input.now || lease.fence !== input.fence || lease.holder !== input.holder || lease.resources !== JSON.stringify(["env:" + input.env]))
    return result("block", "Installed, unexpired env lease with matching holder and fence required");
  const blocked = requirement();
  if (blocked) return blocked;
  const ref = policy.envs?.[input.env]?.require_on;
  if (ref && !tx.get("SELECT 1 FROM reachability WHERE space=? AND ref=? AND sha=?", input.space, refName(ref), input.sha)) return result("block", "SHA is not reachable on " + ref);
  if (tx.get("SELECT 1 FROM executors WHERE space=? AND env=?", input.space, input.env) && !liveState(tx, input.space, input.env)) return result("block", "Environment needs human adoption");
  return result("pass");
}
