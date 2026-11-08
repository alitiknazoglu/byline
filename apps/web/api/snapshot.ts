/**
 * GET /api/snapshot?network=testnet|mainnet: the leaderboard and per-byline detail, indexed from the
 * chain on demand. No JSON in the repo, no cron, no deploy:
 *
 *   fresh copy in Redis (< 90 s)? → return it
 *   otherwise one request takes a lock and re-indexes in memory (registry, agents' transactions, swaps
 *   found on-chain and checked against 1Click), stores the result, returns it; others get the last copy.
 *
 * Vercel's CDN also caches responses (s-maxage 60, stale-while-revalidate), so most visits never run this.
 * Env: KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*), NEAR_RPC_MAINNET / NEAR_RPC_TESTNET.
 */
import { indexNetwork, type Snapshot } from "@bylinecode/indexer/snapshot";
import type { NetworkId } from "@bylinecode/sdk";

export const maxDuration = 60;

const FRESH_MS = 90_000;
const KEEP_S = 7 * 24 * 3600;
const LOCK_MS = 45_000;

type Redis = (cmd: (string | number)[]) => Promise<unknown>;

function redis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return async (cmd) => {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
}

/** Same rule as the site: testnet.by-line.xyz → testnet; www / bare by-line.xyz → mainnet; else testnet. */
function networkOf(request: Request): NetworkId | null {
  const asked = new URL(request.url).searchParams.get("network");
  if (asked) return asked === "mainnet" || asked === "testnet" ? asked : null;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return host === "by-line.xyz" || host === "www.by-line.xyz" ? "mainnet" : "testnet";
}

function reply(body: string, how: "hit" | "stale" | "fresh" | "stale-error", status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
      "access-control-allow-origin": "*",
      "x-byline-snapshot": how,
    },
  });
}

const ageMs = (json: string) => {
  try {
    return Date.now() - Date.parse((JSON.parse(json) as Snapshot).generatedAt);
  } catch {
    return Infinity;
  }
};

export async function GET(request: Request) {
  const network = networkOf(request);
  if (!network) return new Response(JSON.stringify({ error: "network must be testnet or mainnet" }), { status: 400, headers: { "content-type": "application/json" } });
  const r = redis();
  const key = `byline:snapshot:${network}`;
  const lockKey = `byline:snapshot-lock:${network}`;

  let cached: string | null = null;
  if (r) {
    try {
      cached = (await r(["GET", key])) as string | null;
    } catch {
      cached = null;
    }
  }
  if (cached && ageMs(cached) < FRESH_MS) return reply(cached, "hit");

  // Only one request re-indexes at a time; the rest serve the last copy (or wait briefly for the first one).
  let locked = true;
  if (r) {
    try {
      locked = (await r(["SET", lockKey, "1", "NX", "PX", LOCK_MS])) === "OK";
    } catch {
      locked = true;
    }
  }
  if (!locked) {
    if (cached) return reply(cached, "stale");
    for (let i = 0; i < 20 && r; i++) {
      await new Promise((res) => setTimeout(res, 1_000));
      const now = (await r(["GET", key]).catch(() => null)) as string | null;
      if (now) return reply(now, "fresh");
    }
  }

  try {
    const snapshot = await indexNetwork({ network, oneClickJwt: process.env.ONECLICK_JWT || undefined, explorerJwt: process.env.EXPLORER_JWT || undefined });
    const body = JSON.stringify(snapshot);
    if (r) await r(["SET", key, body, "EX", KEEP_S]).catch(() => {});
    return reply(body, "fresh");
  } catch (e) {
    if (cached) return reply(cached, "stale-error");
    return new Response(JSON.stringify({ error: `couldn't index ${network} right now: ${(e as Error).message}` }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } finally {
    if (r && locked) await r(["DEL", lockKey]).catch(() => {});
  }
}
