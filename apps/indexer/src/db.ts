import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Where a row came from. `fixture` rows are sample data for the no-keys demo and are
 * always labelled as such; everything else was read from a live source.
 */
export type Source = "chain" | "registry" | "sdk" | "oneclick" | "explorer" | "fixture";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bylines (
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  owner TEXT NOT NULL,
  payout TEXT,
  fee_bps INTEGER NOT NULL,
  account TEXT,
  title TEXT,
  description TEXT,
  created_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (network, name)
);

-- Accounts whose activity counts for a byline: its own sub-account and linked accounts.
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('own', 'linked')),
  source TEXT NOT NULL,
  PRIMARY KEY (network, account_id)
);

-- Transactions signed by a byline's accounts.
CREATE TABLE IF NOT EXISTS txs (
  hash TEXT NOT NULL,
  network TEXT NOT NULL,
  name TEXT NOT NULL,
  signer TEXT NOT NULL,
  receiver TEXT NOT NULL,
  methods TEXT NOT NULL,
  deposit_yocto TEXT NOT NULL,
  success INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  block_ts_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (network, hash)
);

-- NEP-141 transfers whose memo starts with byline:<name>.
CREATE TABLE IF NOT EXISTS memo_transfers (
  tx_hash TEXT NOT NULL,
  action_index INTEGER NOT NULL,
  network TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount TEXT NOT NULL,
  memo TEXT NOT NULL,
  success INTEGER NOT NULL,
  block_ts_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (network, tx_hash, action_index)
);

-- NEP-297 events the registry emitted.
CREATE TABLE IF NOT EXISTS registry_events (
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  standard TEXT NOT NULL,
  event TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  block_ts_ms INTEGER NOT NULL,
  PRIMARY KEY (network, receipt_id, log_index)
);

-- 1Click swaps credited to a byline (always NEAR mainnet settlement).
CREATE TABLE IF NOT EXISTS swaps (
  deposit_address TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  origin_asset TEXT,
  destination_asset TEXT,
  amount_in TEXT,
  amount_out TEXT,
  amount_in_usd REAL,
  amount_out_usd REAL,
  builder_fee_bps INTEGER NOT NULL DEFAULT 0,
  app_fees TEXT NOT NULL DEFAULT '[]',
  deposit_tx TEXT,
  sender TEXT,
  refund_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL
);

-- Quotes the SDK recorded, including dry ones (shown as previews, never counted as volume).
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  name TEXT NOT NULL,
  dry INTEGER NOT NULL,
  correlation_id TEXT,
  deposit_address TEXT,
  origin_asset TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  amount_in TEXT,
  amount_out TEXT,
  amount_in_usd REAL,
  builder_fee_bps INTEGER NOT NULL,
  warnings TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (at, name, origin_asset, destination_asset, amount_in)
);

-- The payout account's balances inside intents.near, where 1Click pays app fees.
CREATE TABLE IF NOT EXISTS intents_balances (
  payout TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (payout, token_id)
);

CREATE TABLE IF NOT EXISTS cursors (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function getCursor(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM cursors WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setCursor(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Run `fn` inside one transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
