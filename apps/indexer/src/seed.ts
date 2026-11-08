/**
 * Sample data for the no-keys demo. Every row is stored with source = 'fixture', and the web app
 * labels it as sample data. Prices come from a real recorded 1Click quote (fixtures/quote-referral_and_fee.json).
 * The bylines, accounts and hashes below are made up and don't exist on-chain, so no explorer links are shown for them.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { NetworkId } from "@by-line/sdk";
import { tx } from "./db.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
/** A fee_bps of 40 pays the builder 20 bps after 1Click's split (measured on live quotes). */
const BUILDER_BPS = 20;
const T0 = Date.parse("2026-11-01T09:00:00Z");
const HOUR = 3_600_000;

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const sampleHash = (s: string) => `sample-${hex(s).slice(0, 40)}`;

interface SeedByline {
  /** Sample code, shaped like the registry's (8 base32 chars). */
  code: string;
  title: string;
  description: string;
  owner: string;
  payout: string;
  linked: string[];
  swaps: { usdc: number; status: "SUCCESS" | "REFUNDED" | "FAILED"; hoursAfter: number }[];
  calls: { receiver: string; method: string; hoursAfter: number }[];
  payments: { receiver: string; usdc: number; note: string; hoursAfter: number }[];
}

const SEED: SeedByline[] = [
  {
    code: "4k9tq2mz",
    title: "Acme Trader",
    description: "DCA bot: buys NEAR with USDC every few hours.",
    owner: "acme-labs.near",
    payout: "acme-treasury.near",
    linked: ["acme-ops.near"],
    swaps: [
      { usdc: 25, status: "SUCCESS", hoursAfter: 1 },
      { usdc: 25, status: "SUCCESS", hoursAfter: 13 },
      { usdc: 50, status: "SUCCESS", hoursAfter: 25 },
      { usdc: 120, status: "SUCCESS", hoursAfter: 49 },
      { usdc: 25, status: "REFUNDED", hoursAfter: 61 },
      { usdc: 250, status: "SUCCESS", hoursAfter: 73 },
      { usdc: 65, status: "SUCCESS", hoursAfter: 97 },
    ],
    calls: [
      { receiver: "intents.near", method: "ft_withdraw", hoursAfter: 26 },
      { receiver: "wrap.near", method: "near_withdraw", hoursAfter: 50 },
      { receiver: "v2.ref-finance.near", method: "get_pool", hoursAfter: 74 },
    ],
    payments: [],
  },
  {
    code: "h7wd3x8n",
    title: "Yield Scout",
    description: "Rebalances between stablecoins and NEAR when yields move.",
    owner: "scout-dev.near",
    payout: "scout-dev.near",
    linked: [],
    swaps: [
      { usdc: 300, status: "SUCCESS", hoursAfter: 5 },
      { usdc: 80, status: "FAILED", hoursAfter: 30 },
      { usdc: 150, status: "SUCCESS", hoursAfter: 55 },
      { usdc: 60, status: "SUCCESS", hoursAfter: 101 },
    ],
    calls: [
      { receiver: "meta-pool.near", method: "deposit_and_stake", hoursAfter: 6 },
      { receiver: "linear-protocol.near", method: "unstake", hoursAfter: 56 },
    ],
    payments: [],
  },
  {
    code: "p2c6vr0e",
    title: "Pay Bot",
    description: "Pays freelancers and APIs in USDC; every payment carries its byline.",
    owner: "paybot-team.near",
    payout: "paybot-team.near",
    linked: ["paybot-hot.near"],
    swaps: [{ usdc: 20, status: "SUCCESS", hoursAfter: 2 }],
    calls: [],
    payments: [
      { receiver: "design-studio.near", usdc: 45, note: "inv-1031", hoursAfter: 3 },
      { receiver: "api-weather.near", usdc: 2, note: "usage-oct", hoursAfter: 20 },
      { receiver: "design-studio.near", usdc: 45, note: "inv-1032", hoursAfter: 68 },
      { receiver: "translate-ai.near", usdc: 12, note: "job-88", hoursAfter: 90 },
    ],
  },
];

interface RecordedQuote {
  response: { quote: { amountIn: string; amountInUsd: string; amountOut: string; amountOutUsd: string } };
}

/** Loads the sample data. Refuses to touch a database that already holds live (non-fixture) rows. */
export async function seedFixtures(db: DatabaseSync, opts: { fixturesDir: string; network?: NetworkId }) {
  const network = opts.network ?? "mainnet";
  const live = db.prepare("SELECT COUNT(*) AS n FROM bylines WHERE source != 'fixture'").get() as { n: number };
  if (live.n > 0) throw new Error("This database has live data; seed a separate demo database instead (e.g. --db data/demo.sqlite)");

  const recorded = JSON.parse(await readFile(`${opts.fixturesDir}/quote-referral_and_fee.json`, "utf8")) as RecordedQuote;
  const q = recorded.response.quote;
  const usdPerUsdc = Number(q.amountInUsd) / (Number(q.amountIn) / 1e6);
  const wnearPerUsdc = Number(BigInt(q.amountOut) / 10n ** 18n) / 1e6 / (Number(q.amountIn) / 1e6);
  const usdPerWnear = Number(q.amountOutUsd) / (Number(BigInt(q.amountOut) / 10n ** 18n) / 1e6);

  const counts = { bylines: 0, accounts: 0, swaps: 0, txs: 0, memoTransfers: 0, quotes: 0, events: 0 };
  tx(db, () => {
    for (const table of ["bylines", "accounts", "txs", "memo_transfers", "swaps", "quotes", "intents_balances"]) {
      db.prepare(`DELETE FROM ${table} WHERE source = 'fixture'`).run();
    }
    db.prepare("DELETE FROM registry_events WHERE tx_hash LIKE 'sample-%'").run();

    for (const b of SEED) {
      const own = `${b.code}.byline.near`;
      db.prepare(
        `INSERT INTO bylines (name, network, owner, payout, fee_bps, account, title, description, created_at_ms, source, synced_at)
         VALUES (?, ?, ?, ?, 40, ?, ?, ?, ?, 'fixture', ?)`,
      ).run(b.code, network, b.owner, b.payout, own, b.title, b.description, T0, new Date(T0).toISOString());
      counts.bylines++;

      const accounts = [own, ...b.linked];
      for (const a of accounts) {
        db.prepare("INSERT INTO accounts (account_id, network, name, kind, source) VALUES (?, ?, ?, ?, 'fixture')").run(a, network, b.code, a === own ? "own" : "linked");
        counts.accounts++;
      }

      const event = (ev: string, data: unknown, at: number) => {
        db.prepare(
          "INSERT INTO registry_events (receipt_id, log_index, network, tx_hash, standard, event, name, data, block_ts_ms) VALUES (?, 0, ?, ?, 'byline', ?, ?, ?, ?)",
        ).run(sampleHash(`r:${b.code}:${ev}:${JSON.stringify(data)}`), network, sampleHash(`t:${b.code}:${ev}:${JSON.stringify(data)}`), ev, b.code, JSON.stringify([data]), at);
        counts.events++;
      };
      event("byline_registered", { code: b.code, owner: b.owner, payout: b.payout, fee_bps: 40, via: "tx" }, T0);
      event("account_created", { code: b.code, account_id: own }, T0 + 60_000);
      for (const a of b.linked) event("account_linked", { code: b.code, account_id: a }, T0 + 120_000);

      let i = 0;
      const insTx = db.prepare(
        `INSERT INTO txs (hash, network, name, signer, receiver, methods, deposit_yocto, success, block_height, block_ts_ms, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'fixture')`,
      );
      for (const s of b.swaps) {
        const at = T0 + s.hoursAfter * HOUR;
        const depositAddress = hex(`deposit:${b.code}:${i}`);
        const amountIn = String(Math.round(s.usdc * 1e6));
        const usd = s.usdc * usdPerUsdc;
        const outWnear = s.usdc * wnearPerUsdc;
        const signer = accounts[i % accounts.length]!;
        const depositTx = sampleHash(`deposit-tx:${b.code}:${i}`);
        db.prepare(
          `INSERT INTO swaps (deposit_address, name, status, origin_asset, destination_asset, amount_in, amount_out, amount_in_usd, amount_out_usd,
             builder_fee_bps, app_fees, deposit_tx, sender, refund_reason, created_at, updated_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture')`,
        ).run(
          depositAddress, b.code, s.status, USDC, WNEAR, amountIn,
          s.status === "SUCCESS" ? (BigInt(Math.round(outWnear * 1e6)) * 10n ** 18n).toString() : null,
          usd, s.status === "SUCCESS" ? outWnear * usdPerWnear : null, BUILDER_BPS,
          JSON.stringify([{ recipient: b.payout, fee: BUILDER_BPS }]), depositTx, signer,
          s.status === "REFUNDED" ? "Price moved beyond slippage before the deposit arrived" : s.status === "FAILED" ? "No solver quote at deposit time" : null,
          new Date(at).toISOString(), new Date(at + 30_000).toISOString(),
        );
        counts.swaps++;
        insTx.run(depositTx, network, b.code, signer, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "storage_deposit,ft_transfer", "1250000000000000000001", 180_000_000 + s.hoursAfter * 3600, at);
        counts.txs++;
        i++;
      }

      b.calls.forEach((c, j) => {
        insTx.run(sampleHash(`call:${b.code}:${j}`), network, b.code, accounts[j % accounts.length]!, c.receiver, c.method, "0", 180_000_000 + c.hoursAfter * 3600, T0 + c.hoursAfter * HOUR);
        counts.txs++;
      });

      b.payments.forEach((p, j) => {
        const hash = sampleHash(`pay:${b.code}:${j}`);
        const signer = accounts[j % accounts.length]!;
        const at = T0 + p.hoursAfter * HOUR;
        insTx.run(hash, network, b.code, signer, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "ft_transfer", "1", 180_000_000 + p.hoursAfter * 3600, at);
        db.prepare(
          `INSERT INTO memo_transfers (tx_hash, action_index, network, name, token, sender, receiver, amount, memo, success, block_ts_ms, source)
           VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'fixture')`,
        ).run(hash, network, b.code, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", signer, p.receiver, String(p.usdc * 1e6), `byline:${b.code} ${p.note}`, at);
        counts.txs++;
        counts.memoTransfers++;
      });

      // Two dry quotes each: what an agent previews before it commits.
      for (let k = 0; k < 2; k++) {
        db.prepare(
          `INSERT INTO quotes (at, name, dry, origin_asset, destination_asset, amount_in, amount_out, amount_in_usd, builder_fee_bps, warnings, source)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, '[]', 'fixture')`,
        ).run(new Date(T0 + (110 + k) * HOUR).toISOString(), b.code, USDC, WNEAR, "10000000", q.amountOut.replace(/^(\d+)/, (d) => (BigInt(d) * 10n).toString()), 10 * usdPerUsdc, BUILDER_BPS);
        counts.quotes++;
      }

      // Fee balance the payout would hold inside intents.near (USDC, 6 decimals).
      const fees = b.swaps.filter((s) => s.status === "SUCCESS").reduce((n, s) => n + (s.usdc * BUILDER_BPS) / 10_000, 0);
      db.prepare("INSERT OR REPLACE INTO intents_balances (payout, token_id, amount, synced_at, source) VALUES (?, ?, ?, ?, 'fixture')").run(
        b.payout, USDC, String(Math.round(fees * 1e6)), new Date(T0 + 120 * HOUR).toISOString(),
      );
    }
  });
  return counts;
}
