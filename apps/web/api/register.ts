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
/** The network this deployment serves when a request doesn't say (testnet.by-line.xyz vs www.by-line.xyz). */
const DEFAULT_NETWORK: NetworkId = (process.env.RELAYER_NETWORK ?? process.env.VITE_NETWORK) === "testnet" ? "testnet" : "mainnet";

function rateStore(): RateStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashRateStore(url, token) : null;
}

function relayerFor(network: NetworkId): Relayer | null {
  const key = network === "mainnet" ? process.env.RELAYER_MAINNET_KEY : process.env.RELAYER_TESTNET_KEY;
  if (!key) return null;
  const shared = rateStore();
  // Real money on mainnet: refuse to sponsor without a rate limit every instance shares.
  if (network === "mainnet" && !shared) return null;
  const powBits = process.env.RELAYER_POW_BITS === undefined ? undefined : Number(process.env.RELAYER_POW_BITS);
  relayers[network] ??= new Relayer({ network, privateKey: key, rateStore: shared ?? memoryRateStore(), powBits });
  return relayers[network]!;
}

/** The client's address as Vercel reports it (it sets these headers itself). */
const clientIp = (request: Request) =>
  request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" },
  });

export function OPTIONS() {
  return json(204, null);
}

export async function POST(request: Request) {
  const network = (new URL(request.url).searchParams.get("network") ?? DEFAULT_NETWORK) as NetworkId;
  if (network !== "mainnet" && network !== "testnet") return json(400, { error: "network must be mainnet or testnet" });
  const relayer = relayerFor(network);
  if (!relayer) return json(503, { error: `Gasless onboarding isn't open on ${network} yet` });
  const body = await request.json().catch(() => null);
  const ip = clientIp(request);
  const r = await relayer.handle(body, ip);
  return json(r.status, r.body);
}

export async function GET(request: Request) {
  const network = (new URL(request.url).searchParams.get("network") ?? DEFAULT_NETWORK) as NetworkId;
  const relayer = relayerFor(network);
  if (!relayer) return json(503, { error: `Gasless onboarding isn't open on ${network} yet` });
  return json(200, { network, registry: relayer.registry.contractId, sponsored: await relayer.registry.getSponsorStatus(), pow_bits: relayer.powBits });
}
