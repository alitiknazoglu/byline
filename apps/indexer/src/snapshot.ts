/**
 * The snapshot the web app reads: leaderboard rows, per-byline detail, summary. Built from a database,
 * or (indexNetwork) from scratch in memory straight off the chain, which is what /api/snapshot runs.
 */
import type { DatabaseSync } from "node:sqlite";
import { registryFor, type NetworkId } from "@bylinecode/sdk";
import { openDb } from "./db.js";
import { bylineDetail, leaderboard, summary, type BylineDetail, type LeaderboardRow } from "./stats.js";
import { createContext, syncAll } from "./sync.js";

export interface Snapshot {
  label: string;
  network: NetworkId;
  registry: string;
  generatedAt: string;
  sample: boolean;
  summary: ReturnType<typeof summary>;
  rows: LeaderboardRow[];
  details: Record<string, BylineDetail | null>;
}

export function buildSnapshot(db: DatabaseSync, network: NetworkId, registry: string, label: string = network): Snapshot {
  const rows = leaderboard(db, network, "volume_usd", 1000);
  return {
    label,
    network,
    registry,
    generatedAt: new Date().toISOString(),
    sample: rows.some((r) => r.sample),
    summary: summary(db, network),
    rows,
    details: Object.fromEntries(rows.map((r) => [r.name, bylineDetail(db, network, r.name, 100)])),
  };
}

/**
 * Index a network from scratch in memory and return its snapshot: registry, agents' transactions and
 * memo payments, swaps found on-chain (checked against 1Click), swap status, intents balances.
 * No files, no local SDK log: everything comes from the chain and 1Click.
 */
export async function indexNetwork(opts: {
  network: NetworkId;
  registryId?: string;
  oneClickJwt?: string;
  explorerJwt?: string;
  log?: (msg: string) => void;
}): Promise<Snapshot> {
  const registry = registryFor(opts.network, opts.registryId);
  const db = openDb(":memory:");
  try {
    const ctx = createContext({ network: opts.network, registryId: registry, oneClickJwt: opts.oneClickJwt, explorerJwt: opts.explorerJwt, log: opts.log });
    await syncAll(db, ctx);
    return buildSnapshot(db, opts.network, registry);
  } finally {
    db.close();
  }
}
