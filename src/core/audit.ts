import { auditSigningText, exportChain, GENESIS_PREV_HASH, eventHash } from "../schema/index.js";
import type { AuditHead, Event } from "../schema/index.js";
import type { Actor, Ctx, Result, SqlTx } from "./types.js";
import { identity, isAdmin } from "./identity.js";
import { fail, ok, spaceRow } from "./log.js";
export function attestAudit(tx: SqlTx, ctx: Ctx, actor: Actor, input: unknown, relayKey: string, published = false): Result {
  const who = identity(tx, ctx, actor);
  if (!who || (!isAdmin(who) && (who.kind !== "ci" || who.session || who.principal !== (ctx.auditExporter ?? "ci:remote")))) return fail(tx, actor.space, "not_authorized", "Configured audit exporter or human admin required");
  if (!input || typeof input !== "object" || !("through_seq" in input) || !Number.isSafeInteger(input.through_seq) || Number(input.through_seq) < 0 || !("xhash" in input) || typeof input.xhash !== "string" || Object.keys(input).length !== 2) return fail(tx, actor.space, "invalid_request", "Expected through_seq and xhash");
  const seq = Number(input.through_seq), space = spaceRow(tx, actor.space);
  if (seq > space.seq) return fail(tx, actor.space, "invalid_request", "Export exceeds relay head");
  const checkpoint = tx.get<{ seq: number; hash: string; xhash: string }>("SELECT seq, hash, xhash FROM audit_checkpoints WHERE space=? AND epoch=? AND seq<=? ORDER BY seq DESC LIMIT 1", actor.space, ctx.epoch, seq);
  const events = tx.all<{ event: string }>("SELECT event FROM events WHERE space=? AND seq>? AND seq<=? ORDER BY seq", actor.space, checkpoint?.seq ?? 0, seq).map(r => JSON.parse(r.event) as Event);
  let throughHash = checkpoint?.hash ?? GENESIS_PREV_HASH, next = (checkpoint?.seq ?? 0) + 1;
  for (const event of events) {
    if (event.seq !== next++ || event.prev_hash !== throughHash || event.hash !== eventHash(throughHash, event)) return fail(tx, actor.space, "resync", "Complete event history required for attestation");
    throughHash = event.hash;
  }
  if (next - 1 !== seq) return fail(tx, actor.space, "resync", "Complete event history required for attestation");
  const approvals = new Set<string>();
  for (const e of events) if (e.body.type === "answer" && tx.get("SELECT 1 FROM asks WHERE space=? AND ask_id=? AND json_extract(body, '$.kind')='approval'", actor.space, e.body.ask_id)) approvals.add(e.body.ask_id);
  const xhash = exportChain(events, checkpoint?.xhash ?? GENESIS_PREV_HASH, approvals).at(-1)?.xhash ?? checkpoint?.xhash ?? GENESIS_PREV_HASH;
  if (xhash !== input.xhash) return fail(tx, actor.space, "conflict", "Export chain does not match relay events");
  if (!ctx.signer) throw new Error("Relay signer required");
  const fields = { space: actor.space, epoch: ctx.epoch, through_seq: seq, through_hash: throughHash, xhash };
  const head: AuditHead = { ...fields, relay_key: relayKey, sig: ctx.signer.sign(auditSigningText(fields)), exported_at: new Date(ctx.now()).toISOString() };
  tx.run("INSERT OR IGNORE INTO audit_checkpoints VALUES (?, ?, ?, ?, ?)", actor.space, ctx.epoch, seq, throughHash, xhash);
  // Signing proves nothing was delivered; the exporter reports publication after its push.
  if (published) tx.run("UPDATE audit_state SET seq=MAX(seq, ?) WHERE space=?", seq, actor.space);
  return ok(tx, actor.space, head);
}
