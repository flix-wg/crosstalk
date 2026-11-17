import { PROTOCOL_VERSION } from "../schema/index.js";
import { checkProtocol } from "./protocol.js";
import { reservationFloor } from "./reservations.js";
import type { Ask as importAsk, Command, CommandArgs, Event as RelayEvent } from "../schema/index.js";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError } from "./config.js";
import type { LoadedConfig } from "./config.js";
import { LocalCache, queueable } from "./cache.js";
import { jcs, sha256 } from "../schema/index.js";
import { verifyRelaySignature } from "./signature.js";
import { scanSecrets } from "./render.js";

export interface RelayResponse<T = unknown> { epoch: string; seq: number; result: T; receipt?: string; payload_hash?: string }
export interface ClientOptions {
  token: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Optional aggregate timing, including response body reads; never exposes request data. */
  onRequest?: (ms: number) => void;
  timeoutMs?: number;
  retries?: number;
  cache?: LocalCache;
  /** Testable jitter source; production uses Math.random. */
  random?: () => number;
}
class TransportError extends Error {}
export class RelayClient {
  private readonly fetcher: typeof fetch;
  private epoch?: string;
  private handshake?: Promise<string>;
  private draining?: Promise<void>;
  outboxError?: ClientError;
  refreshError?: ClientError;
  constructor(readonly config: LoadedConfig, private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    if ((options.timeoutMs ?? 10000) <= 0 || !Number.isInteger(options.retries ?? 3) || (options.retries ?? 3) < 0 || (options.retries ?? 3) > 3)
      throw new ClientError("invalid_config", "Client timeout must be positive and retries between 0 and 3");
  }
  private async pinnedKey(): Promise<string> {
    this.config.assertTrusted();
    if (!this.handshake) this.handshake = (async () => {
      const nonce = randomBytes(32).toString("base64url");
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10000);
      const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
      let response: Response, data: unknown;
      const started = performance.now();
      try {
        response = await this.fetcher(this.config.relay + "/v2/hello", {
          method: "POST", signal, redirect: "error", headers: { "content-type": "application/json", "Crosstalk-Protocol": PROTOCOL_VERSION }, body: JSON.stringify({ nonce }),
        });
        checkProtocol(response);
        data = await response.json();
      } catch (e) { if (e instanceof ClientError) throw e; throw new TransportError("Relay response unavailable"); }
      finally { this.options.onRequest?.(performance.now() - started); }
      if (response.status === 429) throw new ClientError("rate_limited", "Relay handshake rate limited", { retryAfter: Number(response.headers.get("retry-after")) * 1000 });
      if (!response.ok) throw new TransportError("Relay handshake unavailable");
      if (!data || typeof data !== "object" || !("public_key" in data) || typeof data.public_key !== "string" ||
        !("signature" in data) || typeof data.signature !== "string" ||
        !verifyRelaySignature(this.config.relay_key, data.public_key, "crosstalk-hello:" + nonce, data.signature))
        throw new ClientError("relay_key_mismatch", "Relay key verification failed");
      return data.public_key;
    })();
    try { return await this.handshake; }
    catch (e) { if (e instanceof TransportError || (e instanceof ClientError && e.code === "rate_limited")) this.handshake = undefined; throw e; }
  }
  /** Verify exact framed bytes (or JCS payload) using this instance's pinned relay key. */
  async verifyRelaySignature(data: string | Uint8Array, signature: string): Promise<boolean> {
    return verifyRelaySignature(this.config.relay_key, await this.pinnedKey(), data, signature);
  }
  private async once<T>(path: string, input?: unknown, timeoutMs = this.options.timeoutMs ?? 10000, payloadHash?: string): Promise<RelayResponse<T>> {
    this.config.assertTrusted();
    await this.pinnedKey();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    let response: Response, data: unknown;
    const started = performance.now();
    try {
      response = await this.fetcher(this.config.relay + "/v2/spaces/" + encodeURIComponent(this.config.space) + path, {
        method: input === undefined ? "GET" : "POST", signal, redirect: "error",
        headers: { authorization: "Bearer " + this.options.token, "content-type": "application/json", "Crosstalk-Protocol": PROTOCOL_VERSION },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      checkProtocol(response);
      data = await response.json();
    } catch (e) { if (e instanceof ClientError) throw e; throw new TransportError("Relay response unavailable"); }
    finally { this.options.onRequest?.(performance.now() - started); }
    if (!data || typeof data !== "object") throw new TransportError("Invalid relay response");
    const envelope = data as { epoch?: unknown; seq?: unknown; result?: unknown; payload_hash?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } };
    if (payloadHash !== undefined && envelope.payload_hash !== undefined && envelope.payload_hash !== payloadHash)
      throw new ClientError("idempotency_mismatch", "Request ID was already used with another payload");
    if (payloadHash !== undefined && envelope.payload_hash === undefined && envelope.error?.code !== "not_found")
      throw new ClientError("invalid_response", "Receipt payload hash missing");
    if (envelope.error) {
      const code = typeof envelope.error.code === "string" && /^[a-z_]{1,40}$/.test(envelope.error.code) && !/[\r\n]/.test(envelope.error.code) ? envelope.error.code : "invalid_response";
      // Do not repeat untrusted response text (it might echo a credential).
      throw new ClientError(code, "Relay refused request: " + code, { epoch: envelope.epoch, seq: envelope.seq, ...(code === "rate_limited" ? { retryAfter: Number(response.headers.get("retry-after")) * 1000 } : {}), ...(code === "conflict" ? { conflict: envelope.error.details } : {}) });
    }
    if (!response.ok || typeof envelope.epoch !== "string" || !Number.isSafeInteger(envelope.seq) || !("result" in envelope))
      throw new TransportError("Invalid relay response");
    return data as RelayResponse<T>;
  }
  private async observe(response: RelayResponse, path: string): Promise<void> {
    const changed = this.options.cache?.observeEpoch(response.epoch) || (this.epoch !== undefined && this.epoch !== response.epoch);
    this.epoch = response.epoch;
    if (changed && path !== "/board") {
      try {
        const board = await this.once("/board");
        this.epoch = board.epoch;
        this.options.cache?.saveBoard({ epoch: board.epoch, seq: board.seq, snapshot: board.result, fetched_at: Date.now() });
        this.refreshError = undefined;
      } catch (e) {
        this.refreshError = e instanceof ClientError ? e : new ClientError("unknown", "Board refresh unavailable");
      }
    }
  }
  async request<T = unknown>(path: string, input?: unknown, requestId?: string, timeoutMs?: number): Promise<RelayResponse<T>> {
    if (!/^\/[a-z]/.test(path) || path.includes("#")) throw new ClientError("invalid_request", "Invalid relay path");
    this.config.assertTrusted();
    if (!requestId && path === "/commands" && input && typeof input === "object" && "request_id" in input && typeof input.request_id === "string")
      requestId = input.request_id;
    if (input !== undefined) {
      scanSecrets(input);
      if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw new ClientError("payload_too_large", "Request exceeds 16 KiB");
    }
    const payloadHash = requestId && input !== undefined ? sha256(jcs(JSON.parse(JSON.stringify(input)))) : undefined;
    const deadline = performance.now() + (timeoutMs ?? this.options.timeoutMs ?? 10000);
    let rateRetried = false;
    for (let attempt = 0; attempt <= (this.options.retries ?? 3); attempt++) {
      try {
        const response = await this.once<T>(path, input, timeoutMs);
        await this.observe(response, path);
        return response;
      } catch (e) {
        if (e instanceof ClientError && e.details && typeof e.details === "object" && "epoch" in e.details && typeof e.details.epoch === "string")
          await this.observe({ epoch: e.details.epoch, seq: 0, result: null }, path);
        if (this.options.signal?.aborted) throw new ClientError("canceled", "Request canceled");
        if (e instanceof ClientError && e.code === "rate_limited" && !rateRetried) {
          const delay = (e.details as { retryAfter?: number } | undefined)?.retryAfter;
          if (delay !== undefined && Number.isFinite(delay) && delay > 0 && performance.now() + delay < deadline) {
            rateRetried = true;
            await sleep(delay, undefined, { signal: this.options.signal });
            timeoutMs = Math.max(1, Math.floor(deadline - performance.now()));
            attempt--; continue;
          }
        }
        if (!(e instanceof TransportError)) throw e;
        if (requestId) {
          try {
            const receipt = await this.once<T>("/receipts/" + encodeURIComponent(requestId), undefined, undefined, payloadHash);
            await this.observe(receipt, path);
            return receipt;
          } catch (receiptError) {
            if (!(receiptError instanceof TransportError) && !(receiptError instanceof ClientError && receiptError.code === "not_found"))
              throw receiptError;
          }
        }
        if (attempt === (this.options.retries ?? 3))
          throw new ClientError("unknown", "Relay outcome unknown; no lease or reservation may be assumed granted");
        await sleep(100 * 2 ** attempt * (0.5 + (this.options.random ?? Math.random)()));
      }
    }
    throw new ClientError("unknown", "Relay outcome unknown");
  }
  async command<C extends Command>(command: C): Promise<RelayResponse> {
    this.config.assertTrusted();
    if (command.op === "message.send") {
      const bytes = Buffer.byteLength(command.args.parts.map(p => p.kind === "text" ? p.text : "").join(""));
      if (bytes > 4096) throw new ClientError("payload_too_large", "Message text exceeds 4 KiB");
    }
    try {
      const response = await this.request("/commands", command, command.request_id);
      if (command.op === "lease.claim" && response.result && typeof response.result === "object" && "lease_id" in response.result)
        this.options.cache?.set("ttl:" + String(response.result.lease_id), command.args.ttl_s ?? (command.args.mode === "shared" ? 3600 : 300));
      if (command.op === "reserve") this.options.cache?.saveReservation(command.request_id, { command, response });
      await this.reconnectOutbox();
      return response;
    } catch (e) {
      if (e instanceof ClientError && e.code === "unknown" && this.options.cache &&
        queueable(command)) {
        this.options.cache.enqueue(command, this.outboxScope());
        throw new ClientError("queued", "Queued offline; delivery is not yet confirmed");
      }
      throw e;
    }
  }
  async send<Op extends keyof CommandArgs>(op: Op, args: CommandArgs[Op], expect_rev?: number): Promise<RelayResponse> {
    if (op === "reserve") {
      const reservation = args as CommandArgs["reserve"];
      const policy = reservation.abandon === undefined
        ? (await this.request<{ coordination: { policy?: { sequences?: Record<string, string> } } }>("/board")).result.coordination.policy
        : undefined;
      const floor = reservation.abandon === undefined ? reservationFloor(this.config, reservation.sequence, policy?.sequences) : undefined;
      if (floor !== undefined) args = { ...reservation, floor: Math.max(floor, reservation.floor ?? 0) } as CommandArgs[Op];
    }
    // The indexed args/op pair is guaranteed by this signature; TS loses the correlation when constructing a mapped union.
    const command = { request_id: randomUUID(), op, args, ...(expect_rev === undefined ? {} : { expect_rev }) } as Command;
    return this.command(command);
  }
  heartbeat(session: string, state: "working" | "waiting" | "offline" = "working") {
    return this.request("/sessions/" + encodeURIComponent(session) + "/heartbeat", { state });
  }
  async inbox(ack = false) {
    const response = await this.request<{ cursor: number; messages: { seq: number; body: { parts: unknown; to: unknown } }[] }>("/inbox");
    const cursor = response.result.messages.at(-1)?.seq;
    if (ack && cursor !== undefined) {
      await this.send("inbox.ack", { cursor });
      response.result.cursor = cursor;
    }
    return response;
  }
  asks() { return this.request<importAsk[]>("/asks"); }
  check(input: unknown) { return this.request<{ verdict: string }>("/check", input); }
  async releaseSession(session: string): Promise<void> {
    await this.send("session.release", { session });
  }

  async events(options: { after?: number; limit?: number; wait_s?: number } = {}): Promise<RelayResponse<RelayEvent[]>> {
    if (options.wait_s !== undefined && (!Number.isFinite(options.wait_s) || options.wait_s < 0 || options.wait_s > 25))
      throw new ClientError("invalid_request", "Event wait must be between 0 and 25 seconds");
    const after = options.after ?? this.options.cache?.cursor() ?? 0;
    try {
      const response = await this.request<RelayEvent[]>("/events?after=" + after + "&limit=" + (options.limit ?? 100) + "&wait_s=" + (options.wait_s ?? 0), undefined, undefined, Math.max(this.options.timeoutMs ?? 10000, Math.ceil(((options.wait_s ?? 0) + 5) * 1000)));
      const last = response.result.at(-1);
      if (last && last.epoch === this.epoch) {
        this.options.cache?.set("events", [...(this.options.cache.get<RelayEvent[]>("events") ?? []), ...response.result].slice(-1000));
        this.options.cache?.setCursor(last.seq);
      }
      return response;
    } catch (e) {
      if (e instanceof ClientError && e.code === "resync") await this.board();
      throw e;
    }
  }
  async board(): Promise<{ response: RelayResponse; fetched_at: number; offline: boolean }> {
    try {
      const response = await this.request("/board"), fetched_at = Date.now();
      this.options.cache?.saveBoard({ epoch: response.epoch, seq: response.seq, snapshot: response.result, fetched_at });
      await this.reconnectOutbox();
      return { response, fetched_at, offline: false };
    } catch (e) {
      const cached = this.options.cache?.board();
      if (e instanceof ClientError && e.code === "unknown" && cached)
        return { response: { epoch: cached.epoch, seq: cached.seq, result: cached.snapshot }, fetched_at: cached.fetched_at, offline: true };
      throw e;
    }
  }
  private async reconnectOutbox(): Promise<void> {
    try { await this.drainOutbox(); this.outboxError = undefined; }
    catch (e) {
      // An unrelated queued delivery must never hide an acknowledged claim/board.
      this.outboxError = e instanceof ClientError ? e : new ClientError("unknown", "Outbox delivery failed");
    }
  }
  private outboxScope(): string { return sha256(this.options.token); }
  async drainOutbox(): Promise<void> {
    this.config.assertTrusted();
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const command of this.options.cache?.pending(this.outboxScope()) ?? []) {
        try {
          await this.request("/commands", command, command.request_id);
        } catch (error) {
          if (!(error instanceof ClientError) || !["invalid_request", "unsupported_op"].includes(error.code)) throw error;
          console.warn("crosstalk: dropping invalid queued command (" + error.code + ")");
        }
        this.options.cache!.delivered(command.request_id, this.outboxScope());
      }
    })();
    try { await this.draining; } finally { this.draining = undefined; }
  }
}
