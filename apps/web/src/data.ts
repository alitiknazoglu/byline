/** Snapshot types (exported by apps/indexer), loading, and formatting. */

export type Room = "testnet" | "sample" | "mainnet";

export interface Row {
  name: string;
  title: string | null;
  owner: string;
  payout: string | null;
  fee_bps: number;
  account: string | null;
  accounts: number;
  swaps: number;
  swaps_failed: number;
  volume_usd: number;
  builder_fees_usd: number;
  txs: number;
  counterparties: number;
  memo_transfers: number;
  /** Distinct other accounts that paid the agent with its memo. */
  memo_payers: number;
  dry_quotes: number;
  sample: boolean;
}

export interface SwapRow {
  deposit_address: string;
  status: string;
  origin_asset: string | null;
  destination_asset: string | null;
  amount_in: string | null;
  amount_out: string | null;
  amount_in_usd: number | null;
  amount_out_usd: number | null;
  builder_fee_bps: number;
  deposit_tx: string | null;
  sender: string | null;
  refund_reason: string | null;
  created_at: string;
  source: string;
}

export interface TxRow {
  hash: string;
  signer: string;
  receiver: string;
  methods: string;
  success: number;
  block_ts_ms: number;
  source: string;
}

export interface MemoRow {
  tx_hash: string;
  token: string;
  sender: string;
  receiver: string;
  amount: string;
  memo: string;
  success: number;
  block_ts_ms: number;
  source: string;
}

export interface EventRow {
  tx_hash: string;
  standard: string;
  event: string;
  data: string;
  block_ts_ms: number;
}

export interface QuoteRow {
  at: string;
  dry: number;
  origin_asset: string;
  destination_asset: string;
  amount_in: string | null;
  amount_in_usd: number | null;
  builder_fee_bps: number;
  warnings: string;
}

export interface Detail {
  byline: Row;
  accounts: { account_id: string; kind: string }[];
  swaps: SwapRow[];
  txs: TxRow[];
  memoTransfers: MemoRow[];
  events: EventRow[];
  quotes: QuoteRow[];
  intentsBalances: { token_id: string; amount: string }[];
}

export interface Snapshot {
  label: string;
  network: "testnet" | "mainnet";
  registry: string;
  generatedAt: string;
  sample: boolean;
  summary: { bylines: number; accounts: number; swaps: number; volume_usd: number; builder_fees_usd: number; txs: number; memo_transfers: number; memo_payers?: number };
  rows: Row[];
  details: Record<string, Detail>;
}

const cache = new Map<Room, Promise<Snapshot | null>>();

/** The indexer's JSON snapshot for a room, or null when that room has none yet. */
export function loadSnapshot(room: Room): Promise<Snapshot | null> {
  if (!cache.has(room)) {
    cache.set(
      room,
      fetch(`${import.meta.env.BASE_URL}data/${room}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
        .catch(() => null),
    );
  }
  return cache.get(room)!;
}

/** Forget loaded snapshots so the next read fetches the latest index. Returns how many were cached. */
export function clearSnapshotCache(): number {
  const n = cache.size;
  cache.clear();
  return n;
}

// ---------- known tokens (1Click asset ids → symbol, decimals) ----------

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6 },
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6 },
  "nep141:wrap.near": { symbol: "wNEAR", decimals: 24 },
  "wrap.near": { symbol: "wNEAR", decimals: 24 },
  "wrap.testnet": { symbol: "wNEAR", decimals: 24 },
};

export function tokenSymbol(id: string | null | undefined): string {
  if (!id) return "—";
  return TOKENS[id]?.symbol ?? id.replace(/^nep141:/, "").slice(0, 14);
}

export function formatAmount(raw: string | null | undefined, tokenId: string | null | undefined, maxFrac = 4): string {
  if (!raw) return "—";
  const t = tokenId ? TOKENS[tokenId] : undefined;
  if (!t) return raw;
  const v = Number(BigInt(raw) / 10n ** BigInt(Math.max(0, t.decimals - 6))) / 1e6;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: maxFrac })} ${t.symbol}`;
}

export const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2 });

export const count = (n: number) => n.toLocaleString("en-US");

export const day = (ms: number | string) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export const dateTime = (ms: number | string) =>
  new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const short = (s: string, head = 8, tail = 6) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

// ---------- links ----------

export function txUrl(network: "testnet" | "mainnet", hash: string): string | null {
  if (hash.startsWith("sample-")) return null;
  return network === "testnet" ? `https://testnet.nearblocks.io/txns/${hash}` : `https://nearblocks.io/txns/${hash}`;
}

export function accountUrl(network: "testnet" | "mainnet", id: string, sample: boolean): string | null {
  if (sample) return null;
  return network === "testnet" ? `https://testnet.nearblocks.io/address/${id}` : `https://nearblocks.io/address/${id}`;
}

export function swapUrl(depositAddress: string, sample: boolean): string | null {
  return sample ? null : `https://explorer.near-intents.org/transactions/${depositAddress}`;
}
