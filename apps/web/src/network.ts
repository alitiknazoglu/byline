/**
 * Which network this page serves. One build, one Vercel project, picked by the address it's opened on:
 *   testnet.by-line.xyz              → testnet
 *   www.by-line.xyz, by-line.xyz     → mainnet
 *   anything else (localhost, *.vercel.app previews) → VITE_NETWORK, or testnet
 * Everything network-specific lives here so no command hard-codes a network.
 */
export type NetworkId = "testnet" | "mainnet";

/** The network for a host name. Known Byline domains win; otherwise the fallback (VITE_NETWORK or testnet). */
export function networkForHost(host: string, fallback?: string): NetworkId {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "testnet.by-line.xyz") return "testnet";
  if (h === "by-line.xyz" || h === "www.by-line.xyz") return "mainnet";
  return fallback?.trim().toLowerCase() === "mainnet" ? "mainnet" : "testnet";
}

export const NETWORK: NetworkId = networkForHost(
  typeof window === "undefined" ? "" : window.location.hostname,
  import.meta.env.VITE_NETWORK as string | undefined,
);
export const IS_MAINNET = NETWORK === "mainnet";

/** The registry contract (and the parent of every `<code>.<registry>` agent account). */
export const REGISTRY = IS_MAINNET ? "byline.near" : "byline.testnet";
/** Wrapped NEAR, used by `pay`. */
export const WRAP = IS_MAINNET ? "wrap.near" : "wrap.testnet";

export const SITE = IS_MAINNET ? "https://www.by-line.xyz" : "https://testnet.by-line.xyz";
/** The same site on the other network. */
export const OTHER_NETWORK: NetworkId = IS_MAINNET ? "testnet" : "mainnet";
export const OTHER_SITE = IS_MAINNET ? "https://testnet.by-line.xyz" : "https://www.by-line.xyz";

export const agentAccount = (code: string) => `${code}.${REGISTRY}`;

/** Read errors that mean the registry contract isn't deployed on this network yet. */
export function registryMissing(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /CodeDoesNotExist|does not exist|doesn't exist|UNKNOWN_ACCOUNT|MethodNotFound/i.test(m) && m.includes(REGISTRY);
}

/** The agent the site shows by default (`show`, `quote`, `pay`), per network. Set the mainnet one once its agent exists. */
const env = import.meta.env as Record<string, string | undefined>;
export const DEMO_CODE = ((IS_MAINNET ? env.VITE_DEMO_CODE_MAINNET : env.VITE_DEMO_CODE_TESTNET) || "nw5s2ea1").trim();
/** A transaction the `verify` button checks. Testnet default: nw5s2ea1's first memo payment; none on mainnet until set. */
export const DEMO_TX = ((IS_MAINNET ? env.VITE_DEMO_TX_MAINNET : env.VITE_DEMO_TX_TESTNET) || (IS_MAINNET ? "" : "Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h")).trim();

/** Public RPC for this network (browser-safe; no keys). */
export const PUBLIC_RPC = IS_MAINNET ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";

/**
 * Is the system up? Asks the registry contract itself for its sponsor status over public RPC.
 * True only if the contract answers with real data, so a missing contract or a dead RPC shows red.
 */
export async function registryUp(timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetch(PUBLIC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "status",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: REGISTRY, method_name: "get_sponsor_status", args_base64: btoa("{}") },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: { result?: number[] } };
    const bytes = body.result?.result;
    if (!bytes) return false;
    const status = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as { limit?: unknown };
    return typeof status.limit === "number";
  } catch {
    return false;
  }
}
