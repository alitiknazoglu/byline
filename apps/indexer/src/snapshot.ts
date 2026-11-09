/**
 * The snapshot the web app reads: leaderboard rows, per-byline detail, summary. Built from a database,
 * or (indexNetwork) from scratch in memory straight off the chain, which is what /api/snapshot runs.
 */
import type { DatabaseSync } from "node:sqlite";
import { registryFor, type NetworkId } from "@by-line/sdk";
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
  /** False when a time budget or cap cut indexing short: the numbers are a lower bound. */
  complete: boolean;
}

/** Rows per list in each byline's detail; text written by strangers is shortened. */
const DETAIL_ROWS = 25;
const shorten = (v: unknown, n = 64) => (typeof v === "string" && v.length > n ? `${v.slice(0, n)}…` : v);

export function buildSnapshot(db: DatabaseSync, network: NetworkId, registry: string, label: string = network, complete = true): Snapshot {
  const rows = leaderboard(db, network, "volume_usd", 1000);
  return {
    label,
    network,
    registry,
    generatedAt: new Date().toISOString(),
    sample: rows.some((r) => r.sample),
    summary: summary(db, network),
    rows,
    // The leaderboard is computed once; each detail reuses its row instead of recomputing all of them.
    details: Object.fromEntries(
      rows.map((r) => {
        const d = bylineDetail(db, network, r.name, DETAIL_ROWS, r);
        if (d) d.memoTransfers = d.memoTransfers.map((m) => ({ ...m, memo: shorten(m.memo), receiver: shorten(m.receiver), sender: shorten(m.sender) }));
        return [r.name, d];
      }),
    ),
    complete,
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
  /** Stop fetching after this long and build the snapshot from what's in (default: no limit). */
  budgetMs?: number;
}): Promise<Snapshot> {
  const registry = registryFor(opts.network, opts.registryId);
  const db = openDb(":memory:");
  try {
    const ctx = createContext({
      network: opts.network,
      registryId: registry,
      oneClickJwt: opts.oneClickJwt,
      explorerJwt: opts.explorerJwt,
      log: opts.log,
      deadline: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    });
    await syncAll(db, ctx);
    return buildSnapshot(db, opts.network, registry, opts.network, !ctx.truncated);
  } finally {
    db.close();
  }
}
