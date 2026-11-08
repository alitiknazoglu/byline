/**
 * GET /api/snapshot?network=testnet|mainnet: the leaderboard and per-byline detail, indexed from the
 * chain on demand. No JSON in the repo, no cron, no deploy:
 *
 *   fresh copy in Redis (< 90 s)? → return it
 *   otherwise one request takes a lock and re-indexes in memory (within a 40 s budget) (registry, agents' transactions, swaps
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
/** Longer than maxDuration: a lock can't expire while its holder is still indexing. */
const LOCK_MS = 75_000;
/** Indexing stops fetching after this and builds the snapshot from what's in, well inside maxDuration. */
const INDEX_BUDGET_MS = 40_000;
/** Don't store a snapshot this big: Vercel's response limit is 4.5 MB. */
const MAX_BODY = 4_000_000;
/** Release the lock only if it's still ours (another instance may hold it after ours expired). */
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

type Redis = (cmd: (string | number)[]) => Promise<unknown>;

function redis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return async (cmd) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(5_000),
    });
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

/** No snapshot to give right now: the site falls back to its static copy. Never cached. */
const unavailable = (why: string) =>
  new Response(JSON.stringify({ error: why }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "10" } });

const ageMs = (json: string) => {
  try {
    return Date.now() - Date.parse((JSON.parse(json) as Snapshot).generatedAt);
  } catch {
    return Infinity;
  }
};

export async function GET(request: Request) {
  // Only ?network= is accepted: random query strings would bypass the CDN cache and reach Redis on every request.
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((k) => k !== "network")) {
    return new Response(JSON.stringify({ error: "the only parameter is network=testnet|mainnet" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const network = networkOf(request);
  if (!network) return new Response(JSON.stringify({ error: "network must be testnet or mainnet" }), { status: 400, headers: { "content-type": "application/json" } });
  const r = redis();
  const key = `byline:snapshot:${network}`;
  const lockKey = `byline:snapshot-lock:${network}`;

  let cached: string | null = null;
  let lockToken: string | null = null;
  if (r) {
    try {
      cached = (await r(["GET", key])) as string | null;
    } catch (e) {
      // Fail closed: without Redis there's no lock, and every request would re-index.
      console.error(`[snapshot] redis GET failed: ${(e as Error).message}`);
      return unavailable("the leaderboard store is unavailable; showing the static copy");
    }
    if (cached && ageMs(cached) < FRESH_MS) return reply(cached, "hit");

    // Only one request re-indexes at a time; the rest serve the last copy, or wait briefly for the first one.
    const token = crypto.randomUUID();
    try {
      lockToken = (await r(["SET", lockKey, token, "NX", "PX", LOCK_MS])) === "OK" ? token : null;
    } catch (e) {
      console.error(`[snapshot] redis lock failed: ${(e as Error).message}`);
      return cached ? reply(cached, "stale") : unavailable("the leaderboard store is unavailable; showing the static copy");
    }
    if (!lockToken) {
      if (cached) return reply(cached, "stale");
      for (let i = 0; i < 8; i++) {
        await new Promise((res) => setTimeout(res, 1_000));
        const now = (await r(["GET", key]).catch(() => null)) as string | null;
        if (now) return reply(now, "fresh");
      }
      return unavailable("the leaderboard is being indexed; try again shortly");
    }
  }

  try {
    const snapshot = await indexNetwork({
      network,
      oneClickJwt: process.env.ONECLICK_JWT || undefined,
      explorerJwt: process.env.EXPLORER_JWT || undefined,
      budgetMs: INDEX_BUDGET_MS,
    });
    const body = JSON.stringify(snapshot);
    if (body.length > MAX_BODY) {
      console.error(`[snapshot] ${network} snapshot is ${body.length} bytes; not storing or serving it`);
      return cached ? reply(cached, "stale-error") : unavailable("the leaderboard is too large to serve right now");
    }
    if (r) await r(["SET", key, body, "EX", KEEP_S]).catch((e) => console.error(`[snapshot] redis SET failed: ${(e as Error).message}`));
    return reply(body, "fresh");
  } catch (e) {
    // Upstream errors can quote third-party responses: log them here, don't send them out.
    console.error(`[snapshot] indexing ${network} failed: ${(e as Error).message}`);
    if (cached) return reply(cached, "stale-error");
    return new Response(JSON.stringify({ error: `couldn't index ${network} right now` }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } finally {
    if (r && lockToken) await r(["EVAL", RELEASE, 1, lockKey, lockToken]).catch(() => {});
  }
}
