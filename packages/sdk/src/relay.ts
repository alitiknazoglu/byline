/**
 * The relayer: turns an agent's signed "register me" into an on-chain registration, paid by the
 * registry. Used by the hosted endpoint (apps/web/api/register.ts) and `npm run relayer`.
 *
 * Its key is a function-call access key on the registry account, limited to `register_signed`:
 * the worst a leaked key can do is spend the sponsor quota.
 */
import { Near } from "near-kit";
import { verifyRegistration, type SignedRegistration } from "./onboard.js";
import { checkPow, DEFAULT_POW_BITS } from "./pow.js";
import { Registry } from "./registry.js";
import { nearConfig, REGISTRY_IDS, type NetworkId } from "./types.js";

export interface RelayerConfig {
  network: NetworkId;
  registryId?: string;
  /** The relayer key (`ed25519:...`), a function-call key on the registry account. */
  privateKey?: string;
  /** A registry client that signs as the registry account (tests, custom setups). Overrides `privateKey`. */
  registry?: Registry;
  /** Registrations allowed per client IP per hour. Default 5. */
  perIpPerHour?: number;
  /**
   * Registrations submitted per hour across every client. Default 10. A brake on bursts: raising the
   * registry's sponsor limit can't be emptied in minutes by many IPs at once.
   */
  globalPerHour?: number;
  /** Proof-of-work difficulty for new registrations (leading zero bits). Default 20; 0 turns it off. */
  powBits?: number;
  /**
   * Where the per-IP counts live. Defaults to memory, which resets with every serverless instance:
   * use `upstashRateStore()` (or your own) in production.
   */
  rateStore?: RateStore;
}

/**
 * Shared relayer state. `hit` counts hits per key in a time window and returns the count after this
 * hit. `claim` marks a key as used for `ttlMs` and returns true only for the first caller (a replay
 * guard and an in-flight lock).
 */
export interface RateStore {
  hit(key: string, windowMs: number): Promise<number>;
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Give back a claim early (the lock's TTL is only the fallback if the holder dies). */
  release(key: string): Promise<void>;
}

/** In-process counts. Fine for `npm run relayer`; not shared across serverless instances. */
export function memoryRateStore(): RateStore {
  const hits = new Map<string, number[]>();
  const claims = new Map<string, number>();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);
      return recent.length;
    },
    async claim(key, ttlMs) {
      const now = Date.now();
      for (const [k, until] of claims) if (until <= now) claims.delete(k);
      if (claims.has(key)) return false;
      claims.set(key, now + ttlMs);
      return true;
    },
    async release(key) {
      claims.delete(key);
    },
  };
}

/**
 * Counts in Upstash Redis over its REST API (works on Vercel, no client library), shared by every
 * instance. `url` and `token` are UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
 */
export function upstashRateStore(url: string, token: string, doFetch: typeof fetch = fetch): RateStore {
  const base = url.replace(/\/+$/, "");
  const post = async (path: string, body: unknown) => {
    const res = await doFetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`rate store HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  return {
    async hit(key, windowMs) {
      // One round trip: create the counter with its expiry if it's new, then count. The expiry is set in
      // the same request as the first count, so a key can never be left without one.
      const k = `byline:rate:${key}`;
      const out = (await post("/pipeline", [["SET", k, "0", "PX", windowMs, "NX"], ["INCR", k]])) as { result?: unknown; error?: string }[];
      const n = Number(Array.isArray(out) ? out[1]?.result : NaN);
      if (!Number.isFinite(n) || n < 1) throw new Error("rate store returned no count");
      return n;
    },
    async claim(key, ttlMs) {
      const out = (await post("", ["SET", `byline:claim:${key}`, "1", "PX", ttlMs, "NX"])) as { result?: unknown };
      if (!out || typeof out !== "object" || !("result" in out)) throw new Error("rate store returned no answer");
      return out.result === "OK";
    },
    async release(key) {
      await post("", ["DEL", `byline:claim:${key}`]);
    },
  };
}

export interface RelayResult {
  status: number;
  body: {
    code?: string;
    account_id?: string;
    tx_hash?: string;
    existing?: boolean;
    error?: string;
    sponsored?: { used: number; limit: number };
    /** On 428: the proof-of-work difficulty to solve. */
    pow_bits?: number;
    /** On 503 while another registration is in flight: when to try again. */
    retry_after_s?: number;
  };
}

const MAX_TTL_MS = 60 * 60_000;
/** How long the one-at-a-time lock outlives a relayer instance that died while holding it. */
const INFLIGHT_TTL_MS = 90_000;

// The registry contract's own rules for a signed register message (contract/src/lib.rs, RegisterMessage).
// The relayer checks them before paying gas: a message the contract would reject costs the relayer's
// allowance and leaves nothing on-chain, so it could otherwise be replayed forever.
const MESSAGE_FIELDS = new Set(["action", "expires_at_ms", "payout", "fee_bps", "title", "description"]);
const MAX_FEE_BPS = 100;
const MAX_TITLE_BYTES = 64;
const MAX_DESCRIPTION_BYTES = 280;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Why the registry would refuse this signed message, or null if it would accept it. */
export function registerMessageProblem(msg: unknown, now = Date.now()): string | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return "message must be a JSON object";
  const m = msg as Record<string, unknown>;
  const unknown = Object.keys(m).filter((k) => !MESSAGE_FIELDS.has(k));
  if (unknown.length) return `message has fields the registry doesn't accept: ${unknown.join(", ")}`;
  if (m.action !== "register") return 'message.action must be "register"';
  const exp = m.expires_at_ms;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return "message.expires_at_ms must be an integer (ms)";
  if (exp <= now) return "The signed message has expired; sign a new one";
  if (exp > now + MAX_TTL_MS) return "The signed message lives too long (max 1 hour)";
  if (m.payout !== undefined && m.payout !== null && (typeof m.payout !== "string" || !ACCOUNT_ID.test(m.payout))) return "message.payout must be a NEAR account id";
  if (m.fee_bps !== undefined && m.fee_bps !== null && (typeof m.fee_bps !== "number" || !Number.isInteger(m.fee_bps) || m.fee_bps < 0 || m.fee_bps > MAX_FEE_BPS))
    return `message.fee_bps must be an integer from 0 to ${MAX_FEE_BPS}`;
  if (m.title !== undefined && m.title !== null && (typeof m.title !== "string" || bytes(m.title) > MAX_TITLE_BYTES)) return `message.title must be at most ${MAX_TITLE_BYTES} bytes`;
  if (m.description !== undefined && m.description !== null && (typeof m.description !== "string" || bytes(m.description) > MAX_DESCRIPTION_BYTES))
    return `message.description must be at most ${MAX_DESCRIPTION_BYTES} bytes`;
  return null;
}

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

export class Relayer {
  readonly registry: Registry;
  readonly powBits: number;
  private readonly perIp: number;
  private readonly globalPerHour: number;
  private readonly rates: RateStore;

  constructor(cfg: RelayerConfig) {
    const registryId = cfg.registryId ?? REGISTRY_IDS[cfg.network];
    if (cfg.registry) {
      this.registry = cfg.registry;
    } else {
      if (!cfg.privateKey) throw new Error("The relayer needs its function-call key (privateKey)");
      const near = new Near({ ...nearConfig(cfg.network), privateKey: cfg.privateKey as `ed25519:${string}`, defaultSignerId: registryId });
      this.registry = new Registry({ network: cfg.network, contractId: registryId, near, signerId: registryId });
    }
    this.perIp = cfg.perIpPerHour ?? 5;
    this.globalPerHour = cfg.globalPerHour ?? 10;
    this.powBits = cfg.powBits ?? DEFAULT_POW_BITS;
    this.rates = cfg.rateStore ?? memoryRateStore();
  }

  async handle(input: unknown, ip = "unknown"): Promise<RelayResult> {
    const reg = input as Partial<SignedRegistration> & { pow?: unknown };
    if (!reg || typeof reg !== "object" || typeof reg.public_key !== "string" || typeof reg.message !== "string" || typeof reg.nonce !== "string" || typeof reg.signature !== "string") {
      return { status: 400, body: { error: "Send {public_key, message, nonce, signature} from signRegistration()" } };
    }
    if (typeof reg.pow !== "undefined" && typeof reg.pow !== "string") return { status: 400, body: { error: "pow must be a string" } };
    let msg: unknown;
    try {
      msg = JSON.parse(reg.message);
    } catch {
      return { status: 400, body: { error: "message must be JSON" } };
    }
    const problem = registerMessageProblem(msg);
    if (problem) return { status: 400, body: { error: problem } };
    // Only the four signed fields go on-chain, whatever else the request carried.
    const signed: SignedRegistration = { public_key: reg.public_key, message: reg.message, nonce: reg.nonce, signature: reg.signature };
    let valid = false;
    try {
      valid = await verifyRegistration(signed, this.registry.contractId);
    } catch {
      valid = false;
    }
    if (!valid) return { status: 401, body: { error: `Invalid signature (sign with recipient "${this.registry.contractId}")` } };

    // Proof-of-work before anything that costs the relayer an RPC call or gas.
    if (!checkPow(signed.signature, reg.pow ?? "", this.powBits)) {
      return {
        status: 428,
        body: { error: `Solve the proof-of-work: add "pow" so sha256("byline-pow:" + signature bytes + pow) starts with ${this.powBits} zero bits (solvePow() in the SDK)`, pow_bits: this.powBits },
      };
    }

    const existing = await this.registry.getBylineForKey(signed.public_key);
    if (existing) return { status: 200, body: { code: existing, account_id: this.registry.agentAccountId(existing), existing: true } };

    const busy = { status: 503, body: { error: "The relayer can't check its rate limit right now; try again shortly" } };
    // One sponsored registration in flight at a time, across every instance. The registry keeps a small
    // solvency margin for the callback that finishes each registration; registrations that overlap would
    // share it. Waiting for FINAL before releasing keeps them one after another.
    try {
      if (!(await this.rates.claim("inflight", INFLIGHT_TTL_MS))) {
        return { status: 503, body: { error: "The relayer is finishing another registration; retry in a few seconds", retry_after_s: 5 } };
      }
    } catch {
      return busy;
    }
    try {
      return await this.submit(signed, ip);
    } finally {
      await this.rates.release("inflight").catch(() => {});
    }
  }

  private async submit(signed: SignedRegistration, ip: string): Promise<RelayResult> {
    const busy = { status: 503, body: { error: "The relayer can't check its rate limit right now; try again shortly" } };
    try {
      const count = await this.rates.hit(`ip:${ip}`, 60 * 60_000);
      if (count > this.perIp) return { status: 429, body: { error: `Too many registrations from this address; try again within the hour` } };
      const total = await this.rates.hit("global", 60 * 60_000);
      if (total > this.globalPerHour) return { status: 429, body: { error: "The relayer has onboarded as many agents as it will this hour; try again later" } };
      // Each signature is submitted at most once, and one key has one registration in flight at a time:
      // a replayed or duplicated body can't make the relayer pay gas twice.
      if (!(await this.rates.claim(`sig:${await sha256Hex(signed.signature)}`, MAX_TTL_MS))) {
        return { status: 409, body: { error: "This signed message was already submitted; sign a new one" } };
      }
      if (!(await this.rates.claim(`key:${signed.public_key}`, 60_000))) {
        return { status: 409, body: { error: "A registration for this key is already in progress; check again in a minute" } };
      }
    } catch {
      return busy;
    }
    const sponsor = await this.registry.getSponsorStatus();
    if (sponsor.used >= sponsor.limit) return { status: 429, body: { error: "Sponsored onboarding is full", sponsored: sponsor } };

    let txHash = "";
    try {
      txHash = await this.registry.registerSigned(signed);
    } catch (e) {
      return { status: 400, body: { error: `The registry refused it: ${(e as Error).message ?? e}` } };
    }
    const code = await this.registry.getBylineForKey(signed.public_key);
    if (!code) return { status: 502, body: { error: "Submitted, but the agent account wasn't created; nothing was charged to you", tx_hash: txHash } };
    return { status: 200, body: { code, account_id: this.registry.agentAccountId(code), tx_hash: txHash, existing: false } };
  }

}
