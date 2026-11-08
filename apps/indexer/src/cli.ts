#!/usr/bin/env node
/**
 * byline-indexer: counts what each byline's agent contributed.
 *
 *   sync        [--network testnet|mainnet] [--db FILE] [--recorded FILE]   one pass over every source
 *   watch       same flags, plus --every SECONDS (default 300)
 *   seed        [--db FILE]                                                 load sample data for the no-keys demo
 *   leaderboard [--network …] [--db FILE] [--sort volume_usd|txs|builder_fees_usd|counterparties] [--json]
 *   show NAME   [--network …] [--db FILE] [--json]
 *   export      [--network …] [--db FILE] [--label NAME] [--out FILE]        JSON snapshot for the web app
 */
import { registryFor } from "@bylinecode/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkId } from "@bylinecode/sdk";
import { openDb } from "./db.js";
import { seedFixtures } from "./seed.js";
import { bylineDetail, leaderboard, summary, type SortKey } from "./stats.js";
import { createContext, syncAll } from "./sync.js";
import { buildSnapshot } from "./snapshot.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(resolve(REPO, ".env"));
} catch {
  /* .env is optional */
}

const [command = "help", ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
    else flags.set(a.slice(2), (i++, next));
  } else positional.push(a);
}

// npm runs workspace scripts inside the package; resolve user paths from where the command was typed.
const userPath = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
const network = (flags.get("network") ?? process.env.NEAR_NETWORK ?? "testnet") as NetworkId;
if (network !== "testnet" && network !== "mainnet") throw new Error(`--network must be testnet or mainnet, got ${network}`);
const dbPath = flags.has("db") ? userPath(flags.get("db")!) : resolve(REPO, "data", command === "seed" ? "demo.sqlite" : `byline-${network}.sqlite`);
const recorded = flags.has("recorded") ? userPath(flags.get("recorded")!) : resolve(REPO, "data", "byline-events.jsonl");
const json = flags.has("json");
const log = (m: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

async function main() {
  switch (command) {
    case "sync":
    case "watch": {
      const db = openDb(dbPath);
      const ctx = createContext({
        network,
        registryId: flags.get("registry") ?? registryFor(network, process.env.REGISTRY_CONTRACT_ID, log),
        explorerJwt: process.env.EXPLORER_JWT || undefined,
        oneClickJwt: process.env.ONECLICK_JWT || undefined,
        log,
      });
      log(`db ${dbPath}, registry ${ctx.registry.contractId} (${network})`);
      const every = Number(flags.get("every") ?? 300) * 1000;
      do {
        try {
          await syncAll(db, ctx, { recordedPath: recorded });
          log(`done: ${JSON.stringify(summary(db, network))}`);
        } catch (e) {
          log(`sync failed: ${(e as Error).message}`);
          if (command === "sync") process.exitCode = 1;
        }
        if (command === "watch") await new Promise((r) => setTimeout(r, every));
      } while (command === "watch");
      break;
    }
    case "seed": {
      const db = openDb(dbPath);
      const counts = await seedFixtures(db, { fixturesDir: resolve(REPO, "fixtures") });
      log(`seeded sample data into ${dbPath}: ${JSON.stringify(counts)}`);
      break;
    }
    case "leaderboard": {
      const db = openDb(dbPath);
      const rows = leaderboard(db, network, (flags.get("sort") ?? "volume_usd") as SortKey);
      if (json) return console.log(JSON.stringify({ network, summary: summary(db, network), rows }, null, 2));
      console.table(
        rows.map((r) => ({
          byline: r.name + (r.sample ? " (sample)" : ""),
          swaps: r.swaps,
          "refunded/failed": r.swaps_failed,
          volume: usd(r.volume_usd),
          "builder fees": usd(r.builder_fees_usd),
          txs: r.txs,
          counterparties: r.counterparties,
          "memo payments": r.memo_transfers,
          accounts: r.accounts,
        })),
      );
      console.log("Volume is gameable (an agent can trade with itself). Read it next to fees paid and unique counterparties.");
      break;
    }
    case "show": {
      const name = positional[0];
      if (!name) throw new Error("usage: show NAME");
      const db = openDb(dbPath);
      const d = bylineDetail(db, network, name);
      if (!d) throw new Error(`No byline "${name}" in ${dbPath} (${network})`);
      console.log(JSON.stringify(d, null, json ? 2 : 1));
      break;
    }
    case "export": {
      const db = openDb(dbPath);
      const label = flags.get("label") ?? network;
      const out = flags.has("out") ? userPath(flags.get("out")!) : resolve(REPO, "apps/web/public/data", `${label}.json`);
      const snapshot = buildSnapshot(db, network, registryFor(network, process.env.REGISTRY_CONTRACT_ID), label);
      const rows = snapshot.rows;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(snapshot, null, 1) + "\n");
      log(`exported ${rows.length} bylines to ${out}`);
      break;
    }
    default:
      console.log(
        [
          "byline-indexer <command>",
          "  sync | watch [--every 300]   read registry, agent transactions, SDK records, 1Click, intents.near",
          "  seed                          load sample data into data/demo.sqlite",
          "  leaderboard [--sort …]        rank bylines",
          "  show NAME                     one byline in detail",
          "  export [--label NAME]         JSON snapshot for the web app (apps/web/public/data/NAME.json)",
          "flags: --network testnet|mainnet  --db FILE  --recorded FILE  --json",
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
