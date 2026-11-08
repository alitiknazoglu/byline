/**
 * Which network this build of the site serves. One codebase, two deployments:
 *   testnet.by-line.xyz → VITE_NETWORK=testnet (default)
 *   www.by-line.xyz     → VITE_NETWORK=mainnet
 * Everything network-specific lives here so no command hard-codes a network.
 */
export type NetworkId = "testnet" | "mainnet";

const raw = (import.meta.env.VITE_NETWORK as string | undefined)?.trim().toLowerCase();

export const NETWORK: NetworkId = raw === "mainnet" ? "mainnet" : "testnet";
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

/** The agent the site shows by default (`show`, `quote`, `pay`). Set per deployment once its agent exists. */
export const DEMO_CODE = ((import.meta.env.VITE_DEMO_CODE as string | undefined) || "nw5s2ea1").trim();
/** A transaction the `verify` button checks. Testnet default: nw5s2ea1's first memo payment. */
export const DEMO_TX = ((import.meta.env.VITE_DEMO_TX as string | undefined) || (IS_MAINNET ? "" : "Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h")).trim();
