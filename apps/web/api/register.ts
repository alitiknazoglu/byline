/**
 * Hosted relayer (Vercel function): POST /api/register?network=testnet|mainnet with the body from
 * the SDK's signRegistration(). The registry pays for the agent's byline and account.
 *
 * Env: RELAYER_TESTNET_KEY / RELAYER_MAINNET_KEY, each a function-call key on the registry
 * account limited to `register_signed` with a finite allowance. Never commit them.
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN: shared per-IP rate limit (required on mainnet;
 * serverless instances don't share memory). RELAYER_POW_BITS: proof-of-work difficulty (default 20).
 */
import { Relayer, memoryRateStore, upstashRateStore, type RateStore } from "@bylinecode/sdk/relay";
import type { NetworkId } from "@bylinecode/sdk";

const relayers: Partial<Record<NetworkId, Relayer>> = {};
/**
 * The network a request is for when it doesn't say: picked by the address it came in on, like the site.
 * testnet.by-line.xyz → testnet; www.by-line.xyz / by-line.xyz → mainnet; anything else (previews) → testnet.
 */
function defaultNetwork(request: Request): NetworkId {
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host).toLowerCase().replace(/:\d+$/, "");
  if (host === "by-line.xyz" || host === "www.by-line.xyz") return "mainnet";
  return "testnet";
}

function rateStore(): RateStore | null {
  // Upstash's own names, or the ones Vercel's Upstash integration sets.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? upstashRateStore(url, token) : null;
}

/**
 * RELAYER_POW_BITS, failing closed: unset or unparsable means the default (20); anything below 16 is raised
 * to 16, so an empty or mistyped value can never switch the proof-of-work off on the hosted relayer.
 */
function powBitsFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return Math.min(28, Math.max(16, n));
}

function relayerFor(network: NetworkId): Relayer | null {
  const key = network === "mainnet" ? process.env.RELAYER_MAINNET_KEY : process.env.RELAYER_TESTNET_KEY;
  if (!key) return null;
  const shared = rateStore();
  // Real money on mainnet: refuse to sponsor without a rate limit every instance shares.
  if (network === "mainnet" && !shared) return null;
  const powBits = powBitsFromEnv(process.env.RELAYER_POW_BITS);
  relayers[network] ??= new Relayer({ network, privateKey: key, rateStore: shared ?? memoryRateStore(), powBits });
  return relayers[network]!;
}

/** The client's address as Vercel reports it (it sets these headers itself). */
const clientIp = (request: Request) =>
  request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

/**
 * Agents call the relayer from servers, where CORS doesn't apply. Browsers may only call it from Byline's own
 * pages: another site can't turn its visitors into a registration farm.
 */
const SITE_ORIGINS = new Set(["https://www.by-line.xyz", "https://by-line.xyz", "https://testnet.by-line.xyz", "http://localhost:5173", "http://localhost:5174"]);

const json = (status: number, body: unknown, request?: Request) => {
  const origin = request?.headers.get("origin");
  const headers: Record<string, string> = { "content-type": "application/json", vary: "origin" };
  if (origin && SITE_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "content-type";
  }
  // 204 can't carry a body (the Response constructor throws), so a preflight answers with none.
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};

export function OPTIONS(request: Request) {
  return json(204, null, request);
}

/** Sponsor status for GET, cached briefly so polling the endpoint doesn't cost an RPC call per request. */
const statusCache: Partial<Record<NetworkId, { at: number; value: unknown }>> = {};

export async function POST(request: Request) {
  const network = (new URL(request.url).searchParams.get("network") ?? defaultNetwork(request)) as NetworkId;
  if (network !== "mainnet" && network !== "testnet") return json(400, { error: "network must be mainnet or testnet" }, request);
  // JSON only: a cross-site form or no-cors "simple" request (text/plain) can't reach the relayer without a
  // CORS preflight, and the preflight only passes for Byline's own pages.
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json(415, { error: "Send the registration as application/json" }, request);
  }
  const relayer = relayerFor(network);
  if (!relayer) return json(503, { error: `Gasless onboarding isn't open on ${network} yet` }, request);
  const raw = await request.text().catch(() => "");
  if (raw.length > 8_192) return json(413, { error: "Registration body too large" }, request);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const ip = clientIp(request);
  const r = await relayer.handle(body, ip);
  return json(r.status, r.body, request);
}

export async function GET(request: Request) {
  const network = (new URL(request.url).searchParams.get("network") ?? defaultNetwork(request)) as NetworkId;
  if (network !== "mainnet" && network !== "testnet") return json(400, { error: "network must be mainnet or testnet" }, request);
  const relayer = relayerFor(network);
  if (!relayer) return json(503, { error: `Gasless onboarding isn't open on ${network} yet` }, request);
  const hit = statusCache[network];
  if (!hit || Date.now() - hit.at > 10_000) statusCache[network] = { at: Date.now(), value: await relayer.registry.getSponsorStatus() };
  return json(200, { network, registry: relayer.registry.contractId, sponsored: statusCache[network]!.value, pow_bits: relayer.powBits }, request);
}
