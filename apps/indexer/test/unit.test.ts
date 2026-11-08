/** Indexer tests. Parsers run on real testnet transactions saved from FastNear (test/fixtures). */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Near } from "near-kit";
import { OneClick, Registry, type BylineEvent } from "@by-line/sdk";
import {
  FastNear,
  ingestRecorded,
  leaderboard,
  openDb,
  parseMemoTransfers,
  parseRegistryEvents,
  parseTx,
  seedFixtures,
  summary,
  syncActivity,
  syncExplorer,
  syncIntentsBalances,
  syncRegistry,
  syncRegistryEvents,
  syncSwapStatus,
  type FastTransaction,
  type SyncContext,
} from "../src/index.js";
import TXS from "./fixtures/fastnear-transactions.json" with { type: "json" };
import ACCOUNT from "./fixtures/fastnear-account-agent.json" with { type: "json" };

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const byHash = new Map((TXS.transactions as unknown as FastTransaction[]).map((t) => [t.transaction.hash, t]));
const tx = (prefix: string) => [...byHash.values()].find((t) => t.transaction.hash.startsWith(prefix))!;

const MEMO_TX = "Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h";
const CODE = "nw5s2ea1";
const AGENT = "nw5s2ea1.byline.testnet";

// ---------- parsing real transactions ----------

describe("parse (real testnet transactions)", () => {
  it("reads the memo payment", () => {
    const p = parseTx(tx("Aq3o"));
    expect(p).toMatchObject({ hash: MEMO_TX, signer: AGENT, receiver: "wrap.testnet", methods: ["ft_transfer"], success: true });
    expect(p.blockTsMs).toBeGreaterThan(Date.parse("2026-11-01"));
    expect(parseMemoTransfers(tx("Aq3o"))).toEqual([
      expect.objectContaining({
        name: CODE,
        actionIndex: 0,
        token: "wrap.testnet",
        sender: AGENT,
        receiver: "byline.testnet",
        amount: "1000000000000000000000",
        memo: `byline:${CODE} dca-fee`,
        success: true,
      }),
    ]);
  });

  it("credits a memo only if the token contract logged the transfer, and drops malformed args", () => {
    // Same transaction, but the token contract logged nothing: args alone move no tokens, so nothing is credited.
    const silent = structuredClone(tx("Aq3o"));
    for (const r of silent.receipts) r.execution_outcome.outcome.logs = [];
    expect(parseMemoTransfers(silent)).toEqual([expect.objectContaining({ name: CODE, success: false })]);
    // Args that aren't a real amount or account are skipped, not stored (they'd break pages or inflate counts).
    const forged = structuredClone(tx("Aq3o"));
    const action = (forged.transaction.actions as unknown as { FunctionCall: { args: string } }[])[0]!;
    const args = JSON.parse(Buffer.from(action.FunctionCall.args, "base64").toString());
    for (const bad of [{ ...args, amount: "x" }, { ...args, receiver_id: "Not An Account" }]) {
      action.FunctionCall.args = Buffer.from(JSON.stringify(bad)).toString("base64");
      expect(parseMemoTransfers(forged)).toEqual([]);
    }
    // A long memo is kept short.
    action.FunctionCall.args = Buffer.from(JSON.stringify({ ...args, memo: `byline:${CODE} ${"x".repeat(5000)}` })).toString("base64");
    expect(parseMemoTransfers(forged)[0]!.memo.length).toBe(256);
  });

  it("marks the refused NFT transfer as failed and finds no memo", () => {
    expect(parseTx(tx("8J3P")).success).toBe(false);
    expect(parseMemoTransfers(tx("8J3P"))).toEqual([]);
    expect(parseRegistryEvents(tx("8J3P"), "byline.testnet")).toEqual([]);
  });

  it("reads the registry events of a gasless registration", () => {
    expect(parseRegistryEvents(tx("G67v"), "byline.testnet").map((e) => [e.standard, e.event, e.name])).toEqual([
      ["nep171", "nft_mint", CODE],
      ["byline", "byline_registered", CODE],
      ["byline", "account_created", CODE],
      ["byline", "account_linked", CODE],
    ]);
    expect(parseRegistryEvents(tx("G67v"), "other.testnet")).toEqual([]);
  });
});

// ---------- fakes ----------

function fakeFastNear() {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/v0/account")) {
      if (body.max_block_height !== undefined) return Response.json({ account_txs: [], txs_count: 0 });
      if (body.account_id === AGENT) return Response.json(ACCOUNT);
      if (body.account_id === "byline.testnet")
        return Response.json({
          account_txs: ["G67v", "8J3P"].map((p, i) => ({ transaction_hash: tx(p).transaction.hash, tx_block_height: 276_688_000 + i, is_signer: true })),
        });
      return Response.json({ account_txs: [] });
    }
    if (url.endsWith("/v0/transactions")) {
      return Response.json({ transactions: (body.tx_hashes as string[]).map((h) => byHash.get(h) ?? null) });
    }
    return new Response("nope", { status: 404 });
  });
  return new FastNear({ fetch: fetchImpl as unknown as typeof fetch, retries: 0 });
}

const DEMO = {
  code: CODE,
  owner: AGENT,
  payout: AGENT,
  fee_bps: 40,
  account: AGENT,
  account_pending: false,
  linked: [],
  invited: [],
  created_at_ms: 1794121300000,
  sponsored: true,
  title: "Byline demo DCA agent",
  description: null,
};

function ctxFor(network: "testnet" | "mainnet", over: Partial<SyncContext> = {}): SyncContext {
  const near = { view: vi.fn(async (_c: string, method: string) => (method === "get_bylines" ? [DEMO] : null)) } as unknown as Near;
  return {
    network,
    registry: new Registry({ network: "testnet", near }),
    fastnear: fakeFastNear(),
    oneClick: new OneClick({ fetch: (async () => Response.json({ status: "SUCCESS", swapDetails: { amountInUsd: "9.99", amountOut: "2700" } })) as unknown as typeof fetch }),
    mainnet: near,
    payoutChecker: { canReceive: async () => false },
    fetch: globalThis.fetch,
    log: () => {},
    sleep: async () => {},
    ...over,
  };
}

// ---------- sync jobs ----------

describe("sync", () => {
  it("indexes the registry, its events and what the agent signed, idempotently", async () => {
    const db = openDb(":memory:");
    const ctx = ctxFor("testnet");
    await syncRegistry(db, ctx);
    expect(db.prepare("SELECT account_id, kind FROM accounts").all()).toEqual([{ account_id: AGENT, kind: "own" }]);

    expect(await syncRegistryEvents(db, ctx)).toBe(4);
    expect(await syncActivity(db, ctx)).toEqual({ txs: 2, memos: 1 });

    // The registration names the agent but the registry signed it: not the agent's own action.
    const hashes = (db.prepare("SELECT hash FROM txs ORDER BY hash").all() as { hash: string }[]).map((r) => r.hash);
    expect(hashes).not.toContain(tx("G67v").transaction.hash);

    expect(await syncRegistryEvents(db, ctx)).toBe(0);
    expect(await syncActivity(db, ctx)).toEqual({ txs: 0, memos: 0 });

    const [row] = leaderboard(db, "testnet");
    expect(row).toMatchObject({ name: CODE, txs: 2, memo_transfers: 1, counterparties: 2, accounts: 1, swaps: 0, sample: false });
  });

  it("ingests SDK records: dry quotes, deposits, and transfers only if the chain confirms them", async () => {
    const db = openDb(":memory:");
    const ctx = ctxFor("testnet");
    await syncRegistry(db, ctx);
    const deposit = "d".repeat(64);
    const events: BylineEvent[] = [
      { kind: "quote", at: "2026-11-08T00:00:00Z", code: CODE, dry: true, originAsset: "nep141:usdc", destinationAsset: "nep141:wrap.near", amountIn: "1000000", amountOut: "27", amountInUsd: "1.0", referral: CODE, appFees: [], builderFeeBps: 0, warnings: ["payout missing"] },
      { kind: "quote", at: "2026-11-08T00:01:00Z", code: CODE, dry: false, depositAddress: deposit, originAsset: "nep141:usdc", destinationAsset: "nep141:wrap.near", amountIn: "10000000", amountOut: "270", amountInUsd: "10.0", referral: CODE, appFees: [{ recipient: "x.near", fee: 40 }], builderFeeBps: 20, warnings: [] },
      { kind: "deposit", at: "2026-11-08T00:01:05Z", code: CODE, depositAddress: deposit, txHash: "depositTx", sender: AGENT, token: "usdc", amount: "10000000" },
      { kind: "transfer", at: "2026-11-08T00:02:00Z", code: CODE, txHash: MEMO_TX, sender: AGENT, token: "wrap.testnet", receiver: "byline.testnet", amount: "1000000000000000000000", memo: `byline:${CODE} dca-fee` },
      { kind: "transfer", at: "2026-11-08T00:03:00Z", code: CODE, txHash: "made-up-hash", sender: AGENT, token: "wrap.testnet", receiver: "x.testnet", amount: "1", memo: `byline:${CODE}` },
    ];
    const dir = await mkdtemp(join(tmpdir(), "idx-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    expect(await ingestRecorded(db, ctx, file)).toEqual({ quotes: 2, swaps: 1, transfers: 1 });
    expect(await ingestRecorded(db, ctx, file)).toEqual({ quotes: 0, swaps: 0, transfers: 0 });

    const swap = db.prepare("SELECT * FROM swaps").get() as Record<string, unknown>;
    expect(swap).toMatchObject({ deposit_address: deposit, status: "PENDING_DEPOSIT", builder_fee_bps: 20, amount_in_usd: 10, source: "sdk" });

    // Status comes from 1Click; only then does it count.
    expect(leaderboard(db, "testnet")[0]!.swaps).toBe(0);
    expect(await syncSwapStatus(db, ctx)).toBe(1);
    const [row] = leaderboard(db, "testnet");
    expect(row).toMatchObject({ swaps: 1, dry_quotes: 1, memo_transfers: 1 });
    expect(row!.volume_usd).toBeCloseTo(9.99);
    expect(row!.builder_fees_usd).toBeCloseTo(9.99 * 0.002);
  });

  it("only asks the Explorer for mainnet bylines, and only with a JWT", async () => {
    const db = openDb(":memory:");
    expect(await syncExplorer(db, ctxFor("testnet", { explorerJwt: "jwt" }))).toBe(0);
    expect(await syncExplorer(db, ctxFor("mainnet"))).toBe(0);

    const fetchImpl = vi.fn(async () =>
      Response.json([
        { depositAddress: "e".repeat(64), status: "SUCCESS", createdAt: "2026-11-08T00:00:00Z", referral: CODE, originAsset: "a", destinationAsset: "b", amountIn: "1", amountOut: "2", amountInUsd: "100", amountOutUsd: "99", appFees: [{ recipient: AGENT, fee: 20 }, { recipient: "f".repeat(64), fee: 20 }] },
      ]),
    );
    const ctx = ctxFor("mainnet", { explorerJwt: "jwt", fetch: fetchImpl as unknown as typeof fetch });
    await syncRegistry(db, ctx);
    expect(await syncExplorer(db, ctx)).toBe(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(`referral=${CODE}`);
    expect(leaderboard(db, "mainnet")[0]).toMatchObject({ swaps: 1, volume_usd: 100 });
    expect(leaderboard(db, "mainnet")[0]!.builder_fees_usd).toBeCloseTo(0.2);
  });

  it("skips intents balances for payouts that can't receive fees", async () => {
    const db = openDb(":memory:");
    const ctx = ctxFor("testnet");
    await syncRegistry(db, ctx);
    expect(await syncIntentsBalances(db, ctx)).toBe(0);
  });
});

// ---------- sample data ----------

describe("seed", () => {
  it("loads labelled sample data with refunds and failures kept out of volume", async () => {
    const db = openDb(":memory:");
    const counts = await seedFixtures(db, { fixturesDir: FIXTURES });
    expect(counts).toMatchObject({ bylines: 3, accounts: 5 });
    const rows = leaderboard(db, "mainnet");
    expect(rows.map((r) => r.name)).toEqual(["4k9tq2mz", "h7wd3x8n", "p2c6vr0e"]);
    expect(rows.every((r) => r.sample)).toBe(true);
    const acme = rows[0]!;
    expect(acme).toMatchObject({ swaps: 6, swaps_failed: 1, accounts: 2 });
    // Volume counts only SUCCESS: 25 + 25 + 50 + 120 + 250 + 65 USDC at the recorded price.
    expect(acme.volume_usd).toBeCloseTo(535 * 0.999654, 2);
    expect(acme.builder_fees_usd).toBeCloseTo(acme.volume_usd * 0.002, 4);
    expect(rows[2]!.memo_transfers).toBe(4);
    expect(summary(db, "mainnet").sample).toBe(true);
    expect(leaderboard(db, "mainnet", "counterparties")[0]!.name).toBe("4k9tq2mz");
    // Re-seeding replaces the sample rows instead of doubling them.
    await seedFixtures(db, { fixturesDir: FIXTURES });
    expect(summary(db, "mainnet").swaps).toBe(10);
  });

  it("refuses to mix sample data into a database with live data", async () => {
    const db = openDb(":memory:");
    await syncRegistry(db, ctxFor("testnet"));
    await expect(seedFixtures(db, { fixturesDir: FIXTURES })).rejects.toThrow(/live data/);
  });
});
