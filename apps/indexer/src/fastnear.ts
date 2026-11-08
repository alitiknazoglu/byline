/** FastNear transactions API: account history and full transactions with receipts and logs. No key needed. */
import type { NetworkId } from "@by-line/sdk";

export const FASTNEAR_TX_API: Record<NetworkId, string> = {
  mainnet: "https://tx.main.fastnear.com",
  testnet: "https://tx.test.fastnear.com",
};

export interface AccountTx {
  account_id: string;
  transaction_hash: string;
  tx_block_height: number;
  tx_block_timestamp: string;
  is_signer: boolean;
  is_real_signer: boolean;
  is_receiver: boolean;
  is_event_log: boolean;
  is_success: boolean;
}

export interface FastOutcome {
  block_timestamp: number;
  block_height: number;
  id: string;
  outcome: {
    logs: string[];
    receipt_ids: string[];
    executor_id: string;
    status: Record<string, unknown>;
  };
}

export interface FastAction {
  FunctionCall?: { method_name: string; args: string; gas: number; deposit: string };
  Transfer?: { deposit: string };
  [kind: string]: unknown;
}

export interface FastTransaction {
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    actions: (FastAction | string)[];
  };
  execution_outcome: FastOutcome;
  receipts: {
    receipt: { receipt_id: string; predecessor_id: string; receiver_id: string; block_timestamp: number };
    execution_outcome: FastOutcome;
  }[];
}

export interface FastNearOptions {
  fetch?: typeof fetch;
  baseUrl?: Partial<Record<NetworkId, string>>;
  /** Retries on 429 / 5xx. Default 4. */
  retries?: number;
}

export class FastNear {
  private readonly fetchImpl: typeof fetch;
  private readonly urls: Record<NetworkId, string>;
  private readonly retries: number;

  constructor(opts: FastNearOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.urls = { ...FASTNEAR_TX_API, ...opts.baseUrl };
    this.retries = opts.retries ?? 4;
  }

  /**
   * All transactions touching `accountId`, newest first, down to `minBlockHeight` (exclusive).
   * Pages backwards with `max_block_height` and stops at the first page with nothing new.
   */
  async accountTxs(network: NetworkId, accountId: string, minBlockHeight = 0): Promise<AccountTx[]> {
    const seen = new Map<string, AccountTx>();
    let maxBlockHeight: number | undefined;
    for (let page = 0; page < 100; page++) {
      const body: Record<string, unknown> = { account_id: accountId };
      if (maxBlockHeight !== undefined) body.max_block_height = maxBlockHeight;
      const res = await this.post<{ account_txs: AccountTx[] }>(network, "/v0/account", body);
      let added = 0;
      for (const t of res.account_txs) {
        if (t.tx_block_height <= minBlockHeight) continue;
        if (!seen.has(t.transaction_hash)) {
          seen.set(t.transaction_hash, t);
          added++;
        }
      }
      const lowest = res.account_txs.at(-1)?.tx_block_height;
      if (!added || lowest === undefined || lowest <= minBlockHeight) break;
      maxBlockHeight = lowest;
    }
    return [...seen.values()];
  }

  /** Full transactions with receipts. Batched 20 hashes per request. */
  async transactions(network: NetworkId, hashes: string[]): Promise<FastTransaction[]> {
    const out: FastTransaction[] = [];
    for (let i = 0; i < hashes.length; i += 20) {
      const res = await this.post<{ transactions: (FastTransaction | null)[] }>(network, "/v0/transactions", {
        tx_hashes: hashes.slice(i, i + 20),
      });
      for (const t of res.transactions) if (t) out.push(t);
    }
    return out;
  }

  private async post<T>(network: NetworkId, path: string, body: unknown): Promise<T> {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.urls[network]}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // A hung upstream can't hold the indexer past its time budget.
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw new Error(`FastNear ${network} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}
