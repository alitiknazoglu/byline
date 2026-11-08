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
import { REGISTRY_IDS, type NetworkId } from "./types.js";

export interface RelayerConfig {
  network: NetworkId;
  registryId?: string;
  /** The relayer key (`ed25519:...`), a function-call key on the registry account. */
  privateKey?: string;
  /** A registry client that signs as the registry account (tests, custom setups). Overrides `privateKey`. */
  registry?: Registry;
  /** Registrations allowed per client IP per hour. Default 5. */
  perIpPerHour?: number;
  /** Proof-of-work difficulty for new registrations (leading zero bits). Default 20; 0 turns it off. */
  powBits?: number;
  /**
   * Where the per-IP counts live. Defaults to memory, which resets with every serverless instance:
   * use `upstashRateStore()` (or your own) in production.
   */
  rateStore?: RateStore;
}

/** Counts hits per key in a time window. `hit` returns the count after this hit. */
export interface RateStore {
  hit(key: string, windowMs: number): Promise<number>;
}

/** In-process counts. Fine for `npm run relayer`; not shared across serverless instances. */
export function memoryRateStore(): RateStore {
  const hits = new Map<string, number[]>();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);
      return recent.length;
    },
  };
}

/**
 * Counts in Upstash Redis over its REST API (works on Vercel, no client library), shared by every
 * instance. `url` and `token` are UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
 */
export function upstashRateStore(url: string, token: string, doFetch: typeof fetch = fetch): RateStore {
  const call = async (cmd: (string | number)[]) => {
    const res = await doFetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error(`rate store HTTP ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
  return {
    async hit(key, windowMs) {
      const n = Number(await call(["INCR", `byline:rate:${key}`]));
      if (n === 1) await call(["PEXPIRE", `byline:rate:${key}`, windowMs]);
      return n;
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
  };
}

const MAX_TTL_MS = 60 * 60_000;

export class Relayer {
  readonly registry: Registry;
  readonly powBits: number;
  private readonly perIp: number;
  private readonly rates: RateStore;

  constructor(cfg: RelayerConfig) {
    const registryId = cfg.registryId ?? REGISTRY_IDS[cfg.network];
    if (cfg.registry) {
      this.registry = cfg.registry;
    } else {
      if (!cfg.privateKey) throw new Error("The relayer needs its function-call key (privateKey)");
      const near = new Near({ network: cfg.network, privateKey: cfg.privateKey as `ed25519:${string}`, defaultSignerId: registryId });
      this.registry = new Registry({ network: cfg.network, contractId: registryId, near, signerId: registryId });
    }
    this.perIp = cfg.perIpPerHour ?? 5;
    this.powBits = cfg.powBits ?? DEFAULT_POW_BITS;
    this.rates = cfg.rateStore ?? memoryRateStore();
  }

  async handle(input: unknown, ip = "unknown"): Promise<RelayResult> {
    const reg = input as Partial<SignedRegistration> & { pow?: string };
    if (!reg || typeof reg.public_key !== "string" || typeof reg.message !== "string" || typeof reg.nonce !== "string" || typeof reg.signature !== "string") {
      return { status: 400, body: { error: "Send {public_key, message, nonce, signature} from signRegistration()" } };
    }
    let msg: { action?: string; expires_at_ms?: number };
    try {
      msg = JSON.parse(reg.message);
    } catch {
      return { status: 400, body: { error: "message must be JSON" } };
    }
    const now = Date.now();
    if (msg.action !== "register") return { status: 400, body: { error: "message.action must be \"register\"" } };
    if (!msg.expires_at_ms || msg.expires_at_ms <= now) return { status: 400, body: { error: "The signed message has expired; sign a new one" } };
    if (msg.expires_at_ms > now + MAX_TTL_MS) return { status: 400, body: { error: "The signed message lives too long (max 1 hour)" } };
    if (!(await verifyRegistration(reg as SignedRegistration, this.registry.contractId))) {
      return { status: 401, body: { error: `Invalid signature (sign with recipient "${this.registry.contractId}")` } };
    }

    const existing = await this.registry.getBylineForKey(reg.public_key);
    if (existing) return { status: 200, body: { code: existing, account_id: this.registry.agentAccountId(existing), existing: true } };

    if (!checkPow(reg.signature!, reg.pow ?? "", this.powBits)) {
      return {
        status: 428,
        body: { error: `Solve the proof-of-work: add "pow" so sha256("byline-pow:" + signature bytes + pow) starts with ${this.powBits} zero bits (solvePow() in the SDK)`, pow_bits: this.powBits },
      };
    }
    let count: number;
    try {
      count = await this.rates.hit(`ip:${ip}`, 60 * 60_000);
    } catch {
      return { status: 503, body: { error: "The relayer can't check its rate limit right now; try again shortly" } };
    }
    if (count > this.perIp) return { status: 429, body: { error: `Too many registrations from this address; try again within the hour` } };
    const sponsor = await this.registry.getSponsorStatus();
    if (sponsor.used >= sponsor.limit) return { status: 429, body: { error: "Sponsored onboarding is full", sponsored: sponsor } };

    let txHash = "";
    try {
      txHash = await this.registry.registerSigned(reg as SignedRegistration);
    } catch (e) {
      return { status: 400, body: { error: `The registry refused it: ${(e as Error).message ?? e}` } };
    }
    const code = await this.registry.getBylineForKey(reg.public_key);
    if (!code) return { status: 502, body: { error: "Submitted, but the agent account wasn't created; nothing was charged to you", tx_hash: txHash } };
    return { status: 200, body: { code, account_id: this.registry.agentAccountId(code), tx_hash: txHash, existing: false } };
  }

}
