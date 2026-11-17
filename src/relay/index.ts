import { IMPLEMENTATION_VERSION, PROTOCOL_VERSION } from "../schema/index.js";
import { provisioningTables, operatorMatches, initializeSpace, createInvitation, redeemInvitation } from "./provision.js";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import * as core from "../core/index.js";
import type { Ctx, Result, SqlTx } from "../core/index.js";
import { openStore } from "../store-sqlite/index.js";
import { sign, verify, validateWireGate, validateGate } from "../schema/index.js";

export interface RelayConfig {
  database: string;
  operatorKey?: string;
  auditExporter?: string;
  host?: string;
  port?: number;
  trustProxy?: boolean;
  signingKeyFile: string;
  /** Per-principal token bucket; defaults 10 burst, 10 per second. */
  rateLimit?: { burst: number; perSecond: number };
  bootstrap?: { space: string; principal: string; humanKey: string; agentKey?: string };
}
const statuses: Record<string, number> = {
  conflict: 409, stale_revision: 409, not_authorized: 403, unauthenticated: 401,
  unsupported_op: 400, unsupported_version: 404, invalid_request: 400, invalid_resource: 400, payload_too_large: 413,
  rate_limited: 429, frozen: 423, not_found: 404, idempotency_mismatch: 422, resync: 409,
};
class HttpError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new HttpError("invalid_request");
  let size = 0;
  const chunks: Buffer[] = [];
  // Event listeners let us reject oversized streams without destroying the response socket.
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) { reject(new HttpError("payload_too_large")); return; }
      chunks.push(chunk);
    });
    req.on("error", () => reject(new HttpError("invalid_request")));
    req.on("end", () => {
      if (size > 16384) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value as Record<string, unknown>);
      } catch { reject(new HttpError("invalid_request")); }
    });
  });
}
function signer(file: string): NonNullable<Ctx["signer"]> & { public_key: string } {
  try {
    writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  if (statSync(file).mode & 0o077) throw new Error("Signing key must have mode 0600");
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 signing key required");
  const pub = createPublicKey(key);
  return { public_key: pub.export({ format: "pem", type: "spki" }).toString(), algorithm: "Ed25519", sign: data => sign(data, key).toString("base64"), verify: (data, sig) => verify(data, Buffer.from(sig, "base64"), pub) };
}
export function restoreDatabase(database: string, space: string): Result {
  const store = openStore(database);
  try {
    return store.tx(tx => {
      core.migrate(tx);
      return core.restore(tx, { now: Date.now, uuid: randomUUID, epoch: core.spaceRow(tx, space).epoch }, space);
    });
  } finally { store.close(); }
}
export async function startRelay(config: RelayConfig): Promise<{ url: string; close(): Promise<void> }> {
  const host = config.host ?? "127.0.0.1";
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !config.trustProxy)
    throw new Error("Non-loopback HTTP requires trustProxy and TLS termination");
  const signing = signer(config.signingKeyFile), store = openStore(config.database);
  const context = (tx: SqlTx, space: string): Ctx => ({ now: Date.now, uuid: randomUUID, epoch: core.spaceRow(tx, space).epoch, signer: signing, auditExporter: config.auditExporter ?? "ci:remote" });
  try {
    store.tx(tx => {
      core.migrate(tx);
      provisioningTables(tx);
      const b = config.bootstrap;
      if (b && !tx.get("SELECT 1 FROM spaces WHERE space=?", b.space)) {
        const ctx: Ctx = { now: Date.now, uuid: randomUUID, epoch: randomUUID(), signer: signing };
        core.createSpace(tx, ctx, b.space);
        const result = core.bootstrapAdmin(tx, ctx, b.space, b.principal, b.humanKey);
        if ("error" in result) throw new Error("Invalid bootstrap");
        if (b.agentKey) {
          const actor = core.authenticate(tx, ctx, b.space, b.humanKey)!;
          if ("error" in core.issueCredential(tx, ctx, actor, b.principal, "agent", b.agentKey)) throw new Error("Invalid bootstrap agent key");
        }
      }
    });
  } catch (e) { store.close(); throw e; }
  const waiters = new Set<() => void>();
  const notify = () => { for (const wake of [...waiters]) wake(); };
  const buckets = new Map<string, { tokens: number; at: number }>();
  const limit = (key: string) => {
    const now = Date.now();
    const { burst, perSecond } = config.rateLimit ?? { burst: 10, perSecond: 10 };
    const bucket = buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * perSecond / 1000);
    bucket.at = now;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) throw new HttpError("rate_limited");
    bucket.tokens--;
  };
  let closing = false;
  const server = createServer((req, res) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let space = "";
    const send = (response: unknown, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "Crosstalk-Protocol": PROTOCOL_VERSION });
      res.end(JSON.stringify(response));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/.well-known/crosstalk" && req.method === "GET") {
        send({ protocol: "crosstalk", versions: [{ version: PROTOCOL_VERSION, base: "/v1" }], deprecated: [], implementation: { name: "crosstalk", version: IMPLEMENTATION_VERSION } });
        return;
      }
      const major = /^\/v(\d+)\//.exec(url.pathname)?.[1];
      if (major !== undefined && major !== "1") throw new HttpError("unsupported_version");
      if (url.pathname === "/v1/hello" && req.method === "POST") {
        limit("hello/" + (config.trustProxy ? String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim() : req.socket.remoteAddress));
        const { nonce } = await body(req);
        if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new HttpError("invalid_request");
        send({ public_key: signing.public_key, signature: signing.sign("crosstalk-hello:" + nonce) });
        return;
      }
      if (url.pathname === "/v1/init" && req.method === "POST") {
        if (!operatorMatches(config.operatorKey, /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "")) throw new HttpError("unauthenticated");
        const input = await body(req);
        const result = store.tx(tx => initializeSpace(tx, input));
        send(result, "error" in result ? statuses[result.error.code] ?? 400 : 200); return;
      }
      const match = /^\/v1\/spaces\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match) throw new HttpError("not_found");
      try { space = decodeURIComponent(match[1]); } catch { throw new HttpError("invalid_request"); }
      const path = match[2];
      if (!store.tx(tx => tx.get("SELECT 1 FROM spaces WHERE space=?", space))) throw new HttpError("not_found");
      const secret = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (path === "/enroll" && req.method === "POST") {
        const input = await body(req);
        const result = store.tx(tx => redeemInvitation(tx, context(tx, space), space, secret, input));
        send(result, "error" in result ? statuses[result.error.code] ?? 400 : 200); return;
      }
      const auth = (tx: SqlTx) => {
        const ctx = context(tx, space), actor = core.authenticate(tx, ctx, space, secret);
        if (!actor) throw new HttpError("unauthenticated");
        return { ctx, actor, who: core.identity(tx, ctx, actor)! };
      };
      const initial = store.tx(auth);
      limit(initial.actor.space + "/" + (initial.actor.session ?? initial.actor.credential_id));
      if (Number(req.headers["content-length"] ?? 0) > 16384) throw new HttpError("payload_too_large");
      if (req.method === "GET" && (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"]))
        throw new HttpError("invalid_request");
      const input = req.method === "POST" ? await body(req) : {};
      if (req.method !== "POST" && req.method !== "GET") throw new HttpError("not_found");
      let wait = Number(url.searchParams.get("wait_s") ?? 0);
      if (!Number.isFinite(wait) || wait < 0 || wait > 25) throw new HttpError("invalid_request");
      const dispatch = (): Result => store.tx(tx => {
        const { ctx, actor, who } = auth(tx);
        const session = () => { if (!actor.session) throw new HttpError("not_authorized"); };
        const sessionOrCI = () => { if (!actor.session && who.kind !== "ci" && !(who.role === "admin" && who.kind === "human")) throw new HttpError("not_authorized"); };
        if (req.method === "POST") {
          if (path === "/sessions") {
            const token = randomBytes(32).toString("base64url");
            const result = core.openSession(tx, ctx, actor, input, token);
            return "error" in result ? result : { ...result, result: { ...(result.result as object), token } };
          }
          const release = /^\/sessions\/([^/]+)\/release$/.exec(path);
          if (release) {
            session();
            if (release[1] !== actor.session) throw new HttpError("not_authorized");
            return core.execute(tx, ctx, actor, { request_id: input.request_id ?? randomUUID(), op: "session.release", args: { session: actor.session } });
          }
          const beat = /^\/sessions\/([^/]+)\/heartbeat$/.exec(path);
          if (beat) {
            session();
            if (beat[1] !== actor.session) throw new HttpError("not_authorized");
            if (!["working", "waiting", "offline"].includes(String(input.state)) || (input.doing !== undefined && typeof input.doing !== "string"))
              throw new HttpError("invalid_request");
            return core.heartbeat(tx, ctx, actor, input.state as "working" | "waiting" | "offline", input.doing as string | undefined);
          }
          if (path === "/invitations") return createInvitation(tx, ctx, actor, input);
          if (path === "/commands") return core.execute(tx, ctx, actor, input);
          if (path === "/check") {
            sessionOrCI();
            const gate = { ...input, space, now: ctx.now() };
            if (!validateWireGate(input) || !validateGate(gate)) return core.fail(tx, space, "invalid_request", "Invalid gate input");
            const result = core.evaluateGate(tx, gate);
            return result.code ? core.fail(tx, space, result.code, result.reasons.join("; ")) : core.ok(tx, space, result);
          }
          if (path === "/audit/attest" || path === "/audit/published") return core.attestAudit(tx, ctx, actor, input, "ed25519:" + createPublicKey(signing.public_key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), path === "/audit/published");
          if (path === "/deploy/ticket") return core.deployTicket(tx, ctx, actor, input);
          if (path === "/executor/install") return core.install(tx, ctx, actor, input);
          if (path === "/deploy/authorize") return core.deployAuthorize(tx, ctx, actor, input.ticket ?? input);
          if (path === "/deploy/report") {
            if (who.kind !== "ci" || actor.session) throw new HttpError("not_authorized");
            return core.execute(tx, ctx, actor, { request_id: input.op, op: "deployment.record", args: input });
          }
        } else {
          if (path === "/identity") return core.ok(tx, space, { principal: who.principal, role: who.role, kind: who.kind, session: who.session });
          const receipt = /^\/receipts\/([^/]+)$/.exec(path);
          if (receipt) return core.query(tx, { kind: "receipt", space, principal: actor.principal, session: actor.session, request_id: receipt[1] });
          if (path === "/events") {
            sessionOrCI();
            return core.query(tx, { kind: "events", space, after: Number(url.searchParams.get("after") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100) });
          }
          if (path === "/inbox") {
            session();
            const inbox = core.query(tx, { kind: "inbox", space, principal: actor.principal, session: actor.session });
            const asks = core.query(tx, { kind: "asks", space, now: ctx.now(), to: actor.principal });
            return "result" in inbox && "result" in asks ? { ...inbox, result: { ...inbox.result as object, asks: asks.result } } : inbox;
          }
          if (path === "/asks") return core.query(tx, { kind: "asks", space, now: ctx.now() });
          if (path === "/board") { sessionOrCI(); return core.query(tx, { kind: "board", space, now: ctx.now() }); }
          if (path === "/audit/head") { sessionOrCI(); return core.query(tx, { kind: "audit", space }); }
        }
        throw new HttpError("not_found");
      });
      let response = dispatch();
      if (req.method === "POST") notify();
      const deadline = Date.now() + wait * 1000;
      while (!closing && path === "/events" && req.method === "GET" && wait > 0 &&
        "result" in response && Array.isArray(response.result) && !response.result.length && !res.destroyed) {
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); waiters.delete(wake); res.off("close", wake); resolve(); };
          const timer = setTimeout(wake, wait * 1000);
          waiters.add(wake);
          res.once("close", wake);
        });
        if (closing || res.destroyed) return;
        response = dispatch();
        wait = Math.max(0, (deadline - Date.now()) / 1000);
      }
      send(response, "error" in response ? statuses[response.error.code] ?? 400 : 200);
    } catch (e) {
      if (closing || res.destroyed) return;
      const code = e instanceof HttpError ? e.code : "internal_error";
      if (code === "rate_limited") res.setHeader("retry-after", String(Math.ceil(1 / (config.rateLimit?.perSecond ?? 10))));
      const meta = store.tx(tx => tx.get<{ epoch: string; seq: number }>("SELECT epoch, seq FROM spaces WHERE space=?", space));
      send({ epoch: meta?.epoch ?? null, seq: meta?.seq ?? 0, error: { code, message: code === "internal_error" ? "Relay operation failed" : code } }, statuses[code] ?? 500);
    }
  }
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const sweep = () => {
    store.tx(tx => {
      const first = tx.get<{ epoch: string }>("SELECT epoch FROM spaces LIMIT 1");
      if (first) core.sweep(tx, { now: Date.now, uuid: randomUUID, epoch: first.epoch, signer: signing });
    });
    notify();
    for (const [key, bucket] of buckets) if (Date.now() - bucket.at > 60000) buckets.delete(key);
  };
  try {
    sweep();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port ?? 0, host, () => { server.off("error", reject); resolve(); });
    });
  } catch (e) { store.close(); throw e; }
  const timer = setInterval(() => { try { sweep(); } catch { console.error("Relay sweep failed"); } }, 5000);
  timer.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid listen address");
  return {
    url: "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + address.port,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      notify();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      store.close();
    },
  };
}
