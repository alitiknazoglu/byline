/** Shapes returned by the registry contract and used across the SDK. */

export type NetworkId = "mainnet" | "testnet";

export const REGISTRY_IDS: Record<NetworkId, string> = {
  mainnet: "byline.near",
  testnet: "byline.testnet",
};

/**
 * A registry id from config (e.g. REGISTRY_CONTRACT_ID) if it belongs to `network`, else the default.
 * Guards against a testnet override leaking into mainnet runs (`x.testnet` on mainnet, or `x.near` on testnet).
 */
export function registryFor(network: NetworkId, override?: string | null, warn?: (m: string) => void): string {
  const id = override?.trim();
  if (!id) return REGISTRY_IDS[network];
  const isTestnetId = id.endsWith(".testnet");
  if ((network === "mainnet") === isTestnetId) {
    warn?.(`ignoring registry override ${id}: it isn't a ${network} account; using ${REGISTRY_IDS[network]}`);
    return REGISTRY_IDS[network];
  }
  return id;
}

/** `get_byline`: one agent's byline as stored in the registry. */
export interface BylineRecord {
  /** The random code the registry generated, e.g. "k7m2x9qa". It is the referral and the memo tag. */
  code: string;
  /** The builder: whoever holds the (non-transferable) byline NFT. For a self-onboarded agent, its own account. */
  owner: string;
  /** Receives the fee share. `null` means no fee is routed. */
  payout: string | null;
  /** Fee the SDK asks 1Click for, in basis points (0-100). */
  fee_bps: number;
  /** The agent's own account `<code>.<registry>`, once created. */
  account: string | null;
  account_pending: boolean;
  /** Other existing accounts linked to this byline. */
  linked: string[];
  /** Accounts invited to link, which haven't called `link_account` yet. */
  invited: string[];
  created_at_ms: number;
  /** Registered gaslessly with a signed message; the registry paid for it. */
  sponsored: boolean;
  /** Human-readable label, e.g. "Acme DCA bot". */
  title: string | null;
  description: string | null;
}

/** One entry of 1Click's `appFees`. */
export interface AppFee {
  recipient: string;
  fee: number;
}

/** `get_attribution` as the contract returns it. */
export interface RegistryAttribution {
  referral: string;
  app_fees: AppFee[];
}

/** `get_sponsor_status`: how many agents the registry has onboarded for free, out of how many. */
export interface SponsorStatus {
  used: number;
  limit: number;
  /** yoctoNEAR each sponsored agent account starts with. */
  seed: string;
}

/**
 * What the SDK actually attaches to a quote, after checking the payout.
 * `appFees` is emptied when the payout can't receive fees (see `warnings`).
 */
export interface Attribution {
  code: string;
  referral: string;
  appFees: AppFee[];
  warnings: string[];
}

/** Everything the SDK records, so an indexer can count the agent's contribution. */
export type BylineEvent =
  | {
      kind: "quote";
      at: string;
      code: string;
      dry: boolean;
      correlationId?: string;
      depositAddress?: string;
      originAsset: string;
      destinationAsset: string;
      amountIn?: string;
      amountOut?: string;
      amountInUsd?: string;
      referral: string;
      appFees: AppFee[];
      /** What the builder actually earns on this swap, in bps, after 1Click's split. */
      builderFeeBps: number;
      warnings: string[];
    }
  | {
      kind: "deposit";
      at: string;
      code: string;
      depositAddress: string;
      txHash: string;
      sender: string;
      token: string;
      amount: string;
    }
  | {
      kind: "transfer";
      at: string;
      code: string;
      txHash: string;
      sender: string;
      token: string;
      receiver: string;
      amount: string;
      memo: string;
    }
  | {
      kind: "status";
      at: string;
      code: string;
      depositAddress: string;
      status: string;
    };

export type Recorder = (event: BylineEvent) => void | Promise<void>;
