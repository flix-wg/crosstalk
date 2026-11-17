import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { ClientError, RelayClient, LocalCache, loadConfig, loadAgentKey, credentialScope, verifyRelaySignature } from "../client/index.js";
import { auditSigningText, eventHash, exportChain, exportHash, GENESIS_PREV_HASH, jcs, validateEvent } from "../schema/index.js";
import type { AuditHead, Event, ExportLine } from "../schema/index.js";
export const AUDIT_REF = "refs/crosstalk/audit/v1";
function git(repo: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", repo, ...args], { input, encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", ...extra } });
}
function current(repo: string): string | undefined {
  try { return git(repo, ["rev-parse", "--verify", AUDIT_REF]).trim(); }
  catch { return undefined; }
}
function snapshot(repo: string, oid: string | undefined): Map<string, string> {
  const files = new Map<string, string>();
  if (oid) for (const name of git(repo, ["ls-tree", "-rz", "--name-only", oid]).split("\0").filter(Boolean)) files.set(name, git(repo, ["show", oid + ":" + name]));
  return files;
}
function bad(file: string, line: number, reason: string): never { throw new ClientError("audit_invalid", `${file}:${line}: ${reason}`); }
function headFrom(files: Map<string, string>, file: string): AuditHead {
  try { const value = JSON.parse(files.get(file)! ) as AuditHead; if (!value || typeof value !== "object") throw new Error(); return value; }
  catch { return bad(file, 1, "Invalid HEAD.json"); }
}
function verifyFiles(files: Map<string, string>, pin: string, space: string): AuditHead {
  const head = headFrom(files, "HEAD.json"), sets = [...files.keys()].filter(f => f === "events/HEAD.json" || /^epochs\/[0-9a-f-]+\/HEAD.json$/.test(f));
  if (!sets.length) bad("HEAD.json", 1, "Missing epoch file set");
  const covered = new Set<string>(); let matched = false;
  for (const file of sets.sort()) {
    const h = headFrom(files, file), prefix = file === "events/HEAD.json" ? "" : file.slice(0, -"HEAD.json".length);
    if (h.space !== space || !Number.isSafeInteger(h.through_seq) || h.through_seq < 0 || typeof h.epoch !== "string" || (prefix && prefix !== `epochs/${h.epoch}/`)) bad(file, 1, "Invalid head identity");
    let pub: string;
    try {
      if (!h.relay_key.startsWith("ed25519:")) throw new Error();
      const raw = Buffer.from(h.relay_key.slice(8), "base64"); if (raw.length !== 32) throw new Error();
      pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" }).export({ format: "pem", type: "spki" }).toString();
    } catch { return bad(file, 1, "Invalid relay key"); }
    let next = 1, prev = GENESIS_PREV_HASH, xprev = GENESIS_PREV_HASH;
    const paths = [...files.keys()].filter(f => f.startsWith(prefix + "events/") && f.endsWith(".jsonl")).sort();
    for (const path of paths) {
      if (!/^events\/\d{4}\/\d{2}\/\d{2}\.jsonl$/.test(path.slice(prefix.length))) bad(path, 1, "Invalid event file path");
      covered.add(path);
      const text = files.get(path)!; if (!text.endsWith("\n")) bad(path, 1, "Missing final newline");
      const lines = text.slice(0, -1).split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line: ExportLine;
        try { line = JSON.parse(lines[i]!) as ExportLine; if (!line || line.xprev !== xprev || exportHash(line) !== line.xhash) throw new Error(); }
        catch { return bad(path, i + 1, "Broken export hash chain"); }
        if (line.x === "event") {
          const e = line.event;
          if (!validateEvent(e) || e.space !== space || e.seq !== next || e.prev_hash !== prev || e.hash !== eventHash(prev, e)) bad(path, i + 1, "Broken event chain or sequence");
          next++; prev = e.hash;
        } else if (line.x === "skip") {
          if (line.from_seq !== next || !Number.isSafeInteger(line.to_seq) || line.to_seq < line.from_seq || line.count !== line.to_seq - line.from_seq + 1 || !/^sha256:[0-9a-f]{64}$/.test(line.last_hash)) bad(path, i + 1, "Invalid skip range");
          next = line.to_seq + 1; prev = line.last_hash;
        } else bad(path, i + 1, "Unknown export line");
        xprev = line.xhash;
      }
    }
    if (h.through_seq !== next - 1 || h.through_hash !== prev || h.xhash !== xprev) bad(file, 1, "Head does not match chains");
    if (!verifyRelaySignature(pin, pub, auditSigningText(h), h.sig)) bad(file, 1, "Invalid pinned relay signature");
    if (jcs(h) === jcs(head)) matched = true;
  }
  for (const path of files.keys()) if (path.endsWith(".jsonl") && !covered.has(path)) bad(path, 1, "Unattested file set");
  if (!matched) bad("HEAD.json", 1, "Head does not match an attested epoch");
  return head;
}
export function verify(repoDir: string): AuditHead {
  const config = loadConfig(repoDir); config.assertTrusted();
  return verifyFiles(snapshot(repoDir, current(repoDir)), config.relay_key, config.space);
}
/** Export to the supplied shared repository; no working tree, configured remotes or branches are changed. */
export async function exportOnce(repoDir: string): Promise<AuditHead> {
  repoDir = resolve(repoDir);
  const config = loadConfig(repoDir); config.assertTrusted();
  const client = new RelayClient(config, { token: loadAgentKey(credentialScope(config)) });
  const cache = new LocalCache(config.commonDir, "audit/" + config.space + "/" + config.relay_key);
  try {
  for (let attempt = 0; attempt < 3; attempt++) {
    const oid = current(repoDir);
    const saved = cache.get<{ oid: string; head: AuditHead; prefix: string; approvals: string[] }>("published");
    const known = oid && saved?.oid === oid ? saved : undefined;
    const files = known ? new Map<string, string>() : snapshot(repoDir, oid);
    const old = known?.head ?? (oid ? verifyFiles(files, config.relay_key, config.space) : undefined);
    const relayHead = await client.request("/audit/head");
    const sameEpoch = old?.epoch === relayHead.epoch;
    const prefix = known && sameEpoch ? known.prefix : !old || (sameEpoch && files.has("events/HEAD.json") && jcs(headFrom(files, "events/HEAD.json")) === jcs(old)) ? "" : `epochs/${relayHead.epoch}/`;
    let after = sameEpoch ? old!.through_seq : 0, xprev = sameEpoch ? old!.xhash : GENESIS_PREV_HASH;
    const approvals = new Set<string>(sameEpoch ? known?.approvals : []);
    let prev = sameEpoch ? old!.through_hash : GENESIS_PREV_HASH;
    if (sameEpoch) for (const [path, text] of files) if (path.startsWith(prefix + "events/") && path.endsWith(".jsonl")) for (const raw of text.trimEnd().split("\n")) {
      const line = JSON.parse(raw) as ExportLine;
      if (line.x === "event" && line.event.body.type === "ask" && line.event.body.kind === "approval") approvals.add(line.event.body.ask_id);
    }
    const through = relayHead.seq;
    while (after < through) {
      const batch = await client.events({ after, limit: Math.min(1000, through - after) });
      if (batch.epoch !== relayHead.epoch) throw new ClientError("epoch_changed", "Relay restored during export; retry");
      const events: Event[] = batch.result;
      if (!events.length) throw new ClientError("resync", "Relay export history is incomplete");
      const lines = exportChain(events, xprev, approvals);
      for (const event of events) if (event.body.type === "ask" && event.body.kind === "approval") approvals.add(event.body.ask_id);
      for (let i = 0; i < lines.length; i++) {
        const e = events[i]!, line = lines[i]!;
        if (e.seq !== after + 1 || e.prev_hash !== prev || !validateEvent(e) || e.hash !== eventHash(prev, e)) throw new ClientError("resync", "Relay export chain gap");
        prev = e.hash;
        const path = prefix + "events/" + e.recorded_at.slice(0, 10).replaceAll("-", "/") + ".jsonl";
        if (known && !files.has(path)) {
          const exists = git(repoDir, ["ls-tree", "--name-only", oid!, "--", path]).trim().length > 0;
          files.set(path, exists ? git(repoDir, ["show", oid + ":" + path]) : "");
        }
        files.set(path, (files.get(path) ?? "") + jcs(line) + "\n"); after = e.seq; xprev = line.xhash;
      }
    }
    const response = await client.request<AuditHead>("/audit/attest", { through_seq: after, xhash: xprev }), head = response.result;
    if (head.epoch !== relayHead.epoch || head.space !== config.space || head.through_seq !== after || head.xhash !== xprev || head.through_hash !== prev || !await client.verifyRelaySignature(auditSigningText(head), head.sig)) throw new ClientError("audit_invalid", "Attestation identity or signature mismatch");
    files.set("HEAD.json", jcs(head) + "\n"); files.set(prefix ? prefix + "HEAD.json" : "events/HEAD.json", jcs(head) + "\n");
    // The immutable base was verified once; new events and the signed checkpoint were verified above.
    const published = async () => { await client.request("/audit/published", { through_seq: after, xhash: xprev }); return head; };
    const remember = (commit: string) => cache.set("published", { oid: commit, head, prefix, approvals: [...approvals] });
    if (sameEpoch && old!.through_seq === after) { remember(oid!); return published(); }
    const temporary = mkdtempSync(join(tmpdir(), "crosstalk-audit-"));
    try {
      const env = { GIT_INDEX_FILE: join(temporary, "index"), GIT_AUTHOR_NAME: "Crosstalk audit", GIT_AUTHOR_EMAIL: "audit@crosstalk.local", GIT_COMMITTER_NAME: "Crosstalk audit", GIT_COMMITTER_EMAIL: "audit@crosstalk.local" };
      git(repoDir, oid ? ["read-tree", oid] : ["read-tree", "--empty"], undefined, env);
      let entries = "";
      for (const [path, text] of files) {
        if (/[\0\n\t]/.test(path)) throw new ClientError("audit_invalid", "Invalid audit tree path");
        const blob = git(repoDir, ["hash-object", "-w", "--stdin"], text).trim(); entries += `100644 ${blob}\t${path}\n`;
      }
      git(repoDir, ["update-index", "--index-info"], entries, env);
      const tree = git(repoDir, ["write-tree"], undefined, env).trim();
      const commit = git(repoDir, ["commit-tree", tree, ...(oid ? ["-p", oid] : [])], `Audit through ${after}\n`, env).trim();
      try { git(repoDir, ["push", "--porcelain", `--force-with-lease=${AUDIT_REF}:${oid ?? ""}`, repoDir, `${commit}:${AUDIT_REF}`]); }
      catch { if (current(repoDir) === oid) throw new ClientError("audit_push_failed", "Audit push failed without a concurrent ref update"); continue; }
      remember(commit);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    return published();
  }
  throw new ClientError("audit_race", "Audit ref changed during three export attempts");
  } finally { cache.close(); }
}
