/**
 * Gasless onboarding: an agent with nothing but a key gets a byline and its own funded account.
 *
 * The agent signs a NEP-413 message ("register me") addressed to the registry. The relayer checks it
 * and submits it with its function-call key on the registry account; the registry verifies the
 * signature on-chain, generates the code, and creates `<code>.<registry>` controlled by the agent's key.
 */
import { generateKey, generateNonce, verifyNep413Signature, type KeyPair } from "near-kit";
import { DEFAULT_POW_BITS, solvePow } from "./pow.js";
import { isValidCode } from "./names.js";
import { Registry } from "./registry.js";
import type { NetworkId } from "./types.js";

/** Where the hosted relayer lives. Pass `relayerUrl` to use your own (e.g. `npm run relayer` locally). */
export const RELAYER_URLS: Record<NetworkId, string> = {
  mainnet: "https://www.by-line.xyz/api/register?network=mainnet",
  testnet: "https://testnet.by-line.xyz/api/register?network=testnet",
};

/** A register message lives 10 minutes by default (the registry accepts at most 1 hour). */
export const REGISTER_TTL_MS = 10 * 60_000;

export interface RegisterFields {
  /** Where swap fees go. Defaults to the agent's own account. Use the human's mainnet account to pay them. */
  payout?: string;
  fee_bps?: number;
  /** Human-readable label, e.g. "Acme DCA bot". */
  title?: string;
  description?: string;
}

/** The body the relayer forwards to `register_signed`. Base64 for nonce and signature. */
export interface SignedRegistration {
  public_key: string;
  message: string;
  nonce: string;
  signature: string;
  /** Proof-of-work answer for the relayer (see pow.ts). Not part of the signed message. */
  pow?: string;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Sign "register me" for `registryId` with the agent's key. Nothing is sent. */
export function signRegistration(keyPair: KeyPair, registryId: string, fields: RegisterFields = {}, ttlMs = REGISTER_TTL_MS): SignedRegistration {
  if (!keyPair.signNep413Message) throw new Error("This key type can't sign NEP-413 messages; use an ed25519 key");
  const body: Record<string, unknown> = { action: "register", expires_at_ms: Date.now() + ttlMs };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") body[k] = v;
  const message = JSON.stringify(body);
  const nonce = generateNonce();
  const signed = keyPair.signNep413Message("byline-agent", { message, recipient: registryId, nonce });
  return { public_key: keyPair.publicKey.toString(), message, nonce: toB64(nonce), signature: signed.signature };
}

/** Check a signed registration locally (what the relayer does before spending gas). */
export async function verifyRegistration(reg: SignedRegistration, registryId: string): Promise<boolean> {
  try {
    return await verifyNep413Signature(
      { accountId: "byline-agent", publicKey: reg.public_key, signature: reg.signature },
      { message: reg.message, recipient: registryId, nonce: fromB64(reg.nonce) },
      { nonceValidation: "none" },
    );
  } catch {
    return false;
  }
}

export interface CreateBylineOptions extends RegisterFields {
  network: NetworkId;
  /** Defaults to byline.near / byline.testnet. */
  registryId?: string;
  /** Defaults to the hosted relayer for the network. */
  relayerUrl?: string;
  /** The agent's key. A new ed25519 key is generated if omitted: keep it, it controls the account. */
  keyPair?: KeyPair;
  fetch?: typeof fetch;
  /** Use this registry client instead of a default read-only one (tests, custom RPC). */
  registry?: Registry;
  /** Proof-of-work difficulty to solve first. Default 20 bits (about a second or three); the relayer says if it wants another. */
  powBits?: number;
}

export interface CreatedByline {
  code: string;
  /** `<code>.<registry>`, controlled by `keyPair`. */
  accountId: string;
  publicKey: string;
  keyPair: KeyPair;
  txHash?: string;
  /** True when this key already had a byline (nothing new was registered). */
  existing: boolean;
}

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Give an agent a byline with nothing but a key: no NEAR needed. Safe to call again with the same
 * key; it returns the existing byline instead of registering twice.
 */
export async function createByline(opts: CreateBylineOptions): Promise<CreatedByline> {
  const keyPair = opts.keyPair ?? generateKey();
  const registry = opts.registry ?? new Registry({ network: opts.network, contractId: opts.registryId });
  const publicKey = keyPair.publicKey.toString();

  const existing = await registry.getBylineForKey(publicKey);
  if (existing) return { code: existing, accountId: registry.agentAccountId(existing), publicKey, keyPair, existing: true };

  const { payout, fee_bps, title, description } = opts;
  const reg = signRegistration(keyPair, registry.contractId, { payout, fee_bps, title, description });
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const relayerUrl = opts.relayerUrl ?? RELAYER_URLS[opts.network];
  type Reply = { code?: string; account_id?: string; tx_hash?: string; error?: string; pow_bits?: number; retry_after_s?: number };
  const post = async (bits: number) => {
    const res = await doFetch(relayerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...reg, pow: await solvePow(reg.signature, bits) }),
    });
    return { res, body: (await res.json().catch(() => null)) as Reply | null };
  };
  let bits = opts.powBits ?? DEFAULT_POW_BITS;
  let { res, body } = await post(bits);
  // The relayer may ask for a different difficulty: solve that once and retry.
  if (res.status === 428 && body?.pow_bits !== undefined && body.pow_bits !== bits) {
    bits = body.pow_bits;
    ({ res, body } = await post(bits));
  }
  // The relayer onboards one agent at a time: if it's busy, wait as it asks and send the same body again.
  for (let i = 0; i < 6 && res.status === 503 && typeof body?.retry_after_s === "number"; i++) {
    await new Promise((r) => setTimeout(r, Math.min(30, Math.max(1, body!.retry_after_s!)) * 1000));
    ({ res, body } = await post(bits));
  }
  if (!body) throw new RelayerError(res.status, `No relayer answered at ${relayerUrl} (HTTP ${res.status}, not JSON). Run one with \`npm run relayer\` and set relayerUrl.`);
  if (!res.ok || !body.code) throw new RelayerError(res.status, `The relayer didn't register this agent: ${body.error ?? `HTTP ${res.status}`}`);
  // Trust the registry, not the relayer: the code must be the one the chain holds for this key, and the
  // account name is derived from it here (it ends up in a key-file path).
  const onChain = await registry.getBylineForKey(publicKey);
  if (!onChain || onChain !== body.code || !isValidCode(onChain)) {
    throw new RelayerError(502, `The relayer answered with code ${JSON.stringify(body.code)}, but the registry holds ${onChain ? `"${onChain}"` : "nothing"} for this key`);
  }
  return {
    code: onChain,
    accountId: registry.agentAccountId(onChain),
    publicKey,
    keyPair,
    txHash: body.tx_hash,
    existing: false,
  };
}
