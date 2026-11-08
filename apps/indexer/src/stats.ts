/** Read side: what the web app and CLI show. */
import type { DatabaseSync } from "node:sqlite";
import type { NetworkId } from "@bylinecode/sdk";

export interface LeaderboardRow {
  name: string;
  title: string | null;
  owner: string;
  payout: string | null;
  fee_bps: number;
  account: string | null;
  accounts: number;
  /** Successful swaps credited through the referral. */
  swaps: number;
  /** Refunded or failed swaps, shown separately and never counted as volume. */
  swaps_failed: number;
  volume_usd: number;
  /** Estimated builder earnings: amount in (USD) × the builder's real share after 1Click's split. */
  builder_fees_usd: number;
  /** Successful transactions signed by the byline's accounts. */
  txs: number;
  /** Distinct accounts and contracts the agent interacted with (receivers outside its own accounts). */
  counterparties: number;
  /** Successful payments with a byline memo sent by the byline's own accounts (proof: the agent signed them). */
  memo_transfers: number;
  /** Distinct other accounts that paid the agent with its memo (claims anyone can make; counted once per payer). */
  memo_payers: number;
  dry_quotes: number;
  /** True if any of this byline's numbers come from sample data. */
  sample: boolean;
}

export type SortKey = "volume_usd" | "txs" | "builder_fees_usd" | "counterparties";

const SORTS: Record<SortKey, string> = {
  volume_usd: "volume_usd DESC, txs DESC",
  txs: "txs DESC, volume_usd DESC",
  builder_fees_usd: "builder_fees_usd DESC, volume_usd DESC",
  counterparties: "counterparties DESC, txs DESC",
};

export function leaderboard(db: DatabaseSync, network: NetworkId, sort: SortKey = "volume_usd", limit = 100): LeaderboardRow[] {
  const rows = db
    .prepare(
      `
    SELECT b.name, b.title, b.owner, b.payout, b.fee_bps, b.account,
      (SELECT COUNT(*) FROM accounts a WHERE a.network = b.network AND a.name = b.name) AS accounts,
      (SELECT COUNT(*) FROM swaps s WHERE s.name = b.name AND s.status = 'SUCCESS') AS swaps,
      (SELECT COUNT(*) FROM swaps s WHERE s.name = b.name AND s.status IN ('REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT')) AS swaps_failed,
      (SELECT COALESCE(SUM(s.amount_in_usd), 0) FROM swaps s WHERE s.name = b.name AND s.status = 'SUCCESS') AS volume_usd,
      (SELECT COALESCE(SUM(s.amount_in_usd * s.builder_fee_bps / 10000.0), 0) FROM swaps s WHERE s.name = b.name AND s.status = 'SUCCESS') AS builder_fees_usd,
      (SELECT COUNT(*) FROM txs t WHERE t.network = b.network AND t.name = b.name AND t.success = 1) AS txs,
      (SELECT COUNT(DISTINCT x.cp) FROM (
          SELECT t.receiver AS cp FROM txs t WHERE t.network = b.network AND t.name = b.name AND t.success = 1
          UNION SELECT m.receiver FROM memo_transfers m WHERE m.network = b.network AND m.name = b.name AND m.success = 1
          UNION SELECT m.sender FROM memo_transfers m WHERE m.network = b.network AND m.name = b.name AND m.success = 1
        ) x WHERE x.cp NOT IN (SELECT a.account_id FROM accounts a WHERE a.network = b.network AND a.name = b.name)) AS counterparties,
      (SELECT COUNT(*) FROM memo_transfers m WHERE m.network = b.network AND m.name = b.name AND m.success = 1
        AND m.sender IN (SELECT a.account_id FROM accounts a WHERE a.network = b.network AND a.name = b.name)
        AND m.receiver NOT IN (SELECT deposit_address FROM swaps)) AS memo_transfers,
      (SELECT COUNT(DISTINCT m.sender) FROM memo_transfers m WHERE m.network = b.network AND m.name = b.name AND m.success = 1
        AND m.amount != '0'
        AND m.sender NOT IN (SELECT a.account_id FROM accounts a WHERE a.network = b.network AND a.name = b.name)) AS memo_payers,
      (SELECT COUNT(*) FROM quotes q WHERE q.name = b.name AND q.dry = 1) AS dry_quotes,
      (b.source = 'fixture'
        OR EXISTS (SELECT 1 FROM swaps s WHERE s.name = b.name AND s.source = 'fixture')
        OR EXISTS (SELECT 1 FROM txs t WHERE t.network = b.network AND t.name = b.name AND t.source = 'fixture')) AS sample
    FROM bylines b
    WHERE b.network = ?
    ORDER BY ${SORTS[sort]}, b.name
    LIMIT ?`,
    )
    .all(network, limit) as unknown as (Omit<LeaderboardRow, "sample"> & { sample: number })[];
  return rows.map((r) => ({ ...r, sample: Boolean(r.sample) }));
}

export interface BylineDetail {
  byline: LeaderboardRow;
  accounts: { account_id: string; kind: string }[];
  swaps: Record<string, unknown>[];
  txs: Record<string, unknown>[];
  memoTransfers: Record<string, unknown>[];
  events: Record<string, unknown>[];
  quotes: Record<string, unknown>[];
  intentsBalances: { token_id: string; amount: string }[];
}

export function bylineDetail(db: DatabaseSync, network: NetworkId, name: string, limit = 50): BylineDetail | null {
  const byline = leaderboard(db, network, "volume_usd", 10_000).find((r) => r.name === name);
  if (!byline) return null;
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
  return {
    byline,
    accounts: all("SELECT account_id, kind FROM accounts WHERE network = ? AND name = ? ORDER BY kind DESC, account_id", network, name) as never,
    swaps: all("SELECT * FROM swaps WHERE name = ? ORDER BY created_at DESC LIMIT ?", name, limit),
    txs: all("SELECT * FROM txs WHERE network = ? AND name = ? ORDER BY block_height DESC LIMIT ?", network, name, limit),
    // Transfers into a swap's deposit address are part of that swap, shown under swaps.
    memoTransfers: all(
      "SELECT * FROM memo_transfers WHERE network = ? AND name = ? AND receiver NOT IN (SELECT deposit_address FROM swaps) ORDER BY block_ts_ms DESC LIMIT ?",
      network,
      name,
      limit,
    ),
    events: all("SELECT * FROM registry_events WHERE network = ? AND name = ? ORDER BY block_ts_ms DESC LIMIT ?", network, name, limit),
    quotes: all("SELECT * FROM quotes WHERE name = ? ORDER BY at DESC LIMIT ?", name, limit),
    intentsBalances: byline.payout
      ? (all("SELECT token_id, amount FROM intents_balances WHERE payout = ? ORDER BY token_id", byline.payout) as never)
      : [],
  };
}

export function summary(db: DatabaseSync, network: NetworkId) {
  const rows = leaderboard(db, network, "volume_usd", 10_000);
  return {
    bylines: rows.length,
    accounts: rows.reduce((n, r) => n + r.accounts, 0),
    swaps: rows.reduce((n, r) => n + r.swaps, 0),
    volume_usd: rows.reduce((n, r) => n + r.volume_usd, 0),
    builder_fees_usd: rows.reduce((n, r) => n + r.builder_fees_usd, 0),
    txs: rows.reduce((n, r) => n + r.txs, 0),
    memo_transfers: rows.reduce((n, r) => n + r.memo_transfers, 0),
    memo_payers: rows.reduce((n, r) => n + r.memo_payers, 0),
    sample: rows.some((r) => r.sample),
  };
}
