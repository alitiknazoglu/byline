/** Sync jobs. Each one reads a live source and upserts rows; all are safe to re-run. */
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { Near } from "near-kit";
import {
  mainnetPayoutChecker,
  nearConfig,
  OneClick,
  Registry,
  TERMINAL_STATUSES,
  type BylineEvent,
  type BylineRecord,
  type NetworkId,
  type PayoutChecker,
  type SwapStatus,
} from "@bylinecode/sdk";
import { getCursor, setCursor, tx } from "./db.js";
import { FastNear } from "./fastnear.js";
import { parseMemoTransfers, parseRegistryEvents, parseTx } from "./parse.js";

export const EXPLORER_API = "https://explorer.near-intents.org/api/v0";

export interface SyncContext {
  network: NetworkId;
  registry: Registry;
  fastnear: FastNear;
  oneClick: OneClick;
  /** Mainnet view client: payout checks and intents.near balances. */
  mainnet: Near;
  payoutChecker: PayoutChecker;
  explorerJwt?: string;
  fetch: typeof fetch;
  log: (msg: string) => void;
  /** Pause between rate-limited calls. Overridable in tests. */
  sleep: (ms: number) => Promise<void>;
}

export function createContext(opts: {
  network: NetworkId;
  registryId?: string;
  explorerJwt?: string;
  oneClickJwt?: string;
  log?: (msg: string) => void;
}): SyncContext {
  const mainnet = new Near(nearConfig("mainnet"));
  return {
    network: opts.network,
    registry: new Registry({ network: opts.network, contractId: opts.registryId }),
    fastnear: new FastNear(),
    oneClick: new OneClick({ jwt: opts.oneClickJwt }),
    mainnet,
    payoutChecker: mainnetPayoutChecker(mainnet),
    explorerJwt: opts.explorerJwt,
    fetch: globalThis.fetch.bind(globalThis),
    log: opts.log ?? (() => {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const now = () => new Date().toISOString();

// ---------- 1. registry state ----------

export async function syncRegistry(db: DatabaseSync, ctx: SyncContext): Promise<BylineRecord[]> {
  const all: BylineRecord[] = [];
  for (let from = 0; ; from += 50) {
    const page = await ctx.registry.getBylines(from, 50);
    all.push(...page);
    if (page.length < 50) break;
  }
  const at = now();
  tx(db, () => {
    const upsertByline = db.prepare(`
      INSERT INTO bylines (name, network, owner, payout, fee_bps, account, title, description, created_at_ms, source, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registry', ?)
      ON CONFLICT(network, name) DO UPDATE SET owner=excluded.owner, payout=excluded.payout, fee_bps=excluded.fee_bps,
        account=excluded.account, title=excluded.title, description=excluded.description, synced_at=excluded.synced_at`);
    const upsertAccount = db.prepare(`
      INSERT INTO accounts (account_id, network, name, kind, source) VALUES (?, ?, ?, ?, 'registry')
      ON CONFLICT(network, account_id) DO UPDATE SET name=excluded.name, kind=excluded.kind`);
    db.prepare("DELETE FROM accounts WHERE network = ? AND source = 'registry'").run(ctx.network);
    for (const b of all) {
      upsertByline.run(b.code, ctx.network, b.owner, b.payout, b.fee_bps, b.account, b.title, b.description, b.created_at_ms, at);
      if (b.account && !b.account_pending) upsertAccount.run(b.account, ctx.network, b.code, "own");
      for (const a of b.linked) if (a !== b.account) upsertAccount.run(a, ctx.network, b.code, "linked");
    }
  });
  ctx.log(`registry: ${all.length} bylines`);
  return all;
}

// ---------- 2. registry events ----------

export async function syncRegistryEvents(db: DatabaseSync, ctx: SyncContext): Promise<number> {
  const key = `registry_events:${ctx.network}:${ctx.registry.contractId}`;
  const since = Number(getCursor(db, key) ?? 0);
  const history = await ctx.fastnear.accountTxs(ctx.network, ctx.registry.contractId, since);
  if (!history.length) return 0;
  const txs = await ctx.fastnear.transactions(ctx.network, history.map((h) => h.transaction_hash));
  let n = 0;
  tx(db, () => {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO registry_events (receipt_id, log_index, network, tx_hash, standard, event, name, data, block_ts_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of txs) {
      for (const e of parseRegistryEvents(t, ctx.registry.contractId)) {
        n += Number(ins.run(e.receiptId, e.logIndex, ctx.network, e.txHash, e.standard, e.event, e.name, JSON.stringify(e.data), e.blockTsMs).changes);
      }
    }
    setCursor(db, key, String(Math.max(since, ...history.map((h) => h.tx_block_height))));
  });
  ctx.log(`registry events: ${n} new`);
  return n;
}

// ---------- 3. agent activity (transactions + memo transfers) ----------

export async function syncActivity(db: DatabaseSync, ctx: SyncContext): Promise<{ txs: number; memos: number }> {
  const accounts = db
    .prepare("SELECT account_id, name FROM accounts WHERE network = ? AND source != 'fixture'")
    .all(ctx.network) as { account_id: string; name: string }[];
  let txCount = 0;
  let memoCount = 0;
  for (const { account_id, name } of accounts) {
    // v2: also reads memo payments others sent (the v1 cursor only looked at what the agent signed).
    const key = `activity2:${ctx.network}:${account_id}`;
    const since = Number(getCursor(db, key) ?? 0);
    const history = await ctx.fastnear.accountTxs(ctx.network, account_id, since);
    // What the agent signed counts as its action (txs + memo payments).
    const signedHashes = new Set(history.filter((h) => h.is_real_signer || h.is_signer).map((h) => h.transaction_hash));
    // Anything else that touches the account is read only for payments whose memo names a byline:
    // someone paying the agent with `byline:<code>` is credited to that code, never counted as the agent's own tx.
    const hashes = [...new Set(history.map((h) => h.transaction_hash))];
    const txs = hashes.length ? await ctx.fastnear.transactions(ctx.network, hashes) : [];
    tx(db, () => {
      const signed = txs.filter((t) => signedHashes.has(t.transaction.hash));
      const others = txs.filter((t) => !signedHashes.has(t.transaction.hash));
      const r = insertTxs(db, ctx.network, name, signed, "chain");
      const o = insertTxs(db, ctx.network, name, others, "chain", { memosOnly: true });
      txCount += r.txs;
      memoCount += r.memos + o.memos;
      if (history.length) setCursor(db, key, String(Math.max(since, ...history.map((h) => h.tx_block_height))));
    });
  }
  ctx.log(`activity: ${accounts.length} accounts, ${txCount} new txs, ${memoCount} new memo transfers`);
  return { txs: txCount, memos: memoCount };
}

function insertTxs(
  db: DatabaseSync,
  network: NetworkId,
  name: string,
  txs: Awaited<ReturnType<FastNear["transactions"]>>,
  source: string,
  opts: { memosOnly?: boolean } = {},
): { txs: number; memos: number } {
  const insTx = db.prepare(`
    INSERT OR IGNORE INTO txs (hash, network, name, signer, receiver, methods, deposit_yocto, success, block_height, block_ts_ms, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insMemo = db.prepare(`
    INSERT OR IGNORE INTO memo_transfers (tx_hash, action_index, network, name, token, sender, receiver, amount, memo, success, block_ts_ms, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let t = 0;
  let m = 0;
  for (const raw of txs) {
    const p = parseTx(raw);
    if (!opts.memosOnly)
      t += Number(
      insTx.run(p.hash, network, name, p.signer, p.receiver, p.methods.join(","), p.depositYocto, p.success ? 1 : 0, p.blockHeight, p.blockTsMs, source).changes,
    );
    for (const mt of parseMemoTransfers(raw)) {
      m += Number(
        insMemo.run(mt.txHash, mt.actionIndex, network, mt.name, mt.token, mt.sender, mt.receiver, mt.amount, mt.memo, mt.success ? 1 : 0, mt.blockTsMs, source).changes,
      );
    }
  }
  return { txs: t, memos: m };
}

// ---------- 4. what the SDK recorded ----------

/**
 * Reads the SDK's JSONL log (`jsonlRecorder`). Quotes are stored as previews. Deposits become swaps
 * whose status comes from 1Click. Transfers are claims: each is checked on-chain before it counts.
 */
export async function ingestRecorded(db: DatabaseSync, ctx: SyncContext, path: string): Promise<{ quotes: number; swaps: number; transfers: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    ctx.log(`recorded: no file at ${path}`);
    return { quotes: 0, swaps: 0, transfers: 0 };
  }
  const key = `recorded:${path}`;
  const lines = text.split("\n").filter(Boolean);
  const start = Number(getCursor(db, key) ?? 0);
  const events: BylineEvent[] = [];
  for (const line of lines.slice(start)) {
    try {
      events.push(JSON.parse(line) as BylineEvent);
    } catch {
      /* skip a torn line */
    }
  }

  const transferHashes = events.filter((e) => e.kind === "transfer").map((e) => (e as Extract<BylineEvent, { kind: "transfer" }>).txHash);
  const verified = transferHashes.length ? await ctx.fastnear.transactions(ctx.network, transferHashes) : [];
  const verifiedByHash = new Map(verified.map((t) => [t.transaction.hash, t]));

  let quotes = 0;
  let swaps = 0;
  let transfers = 0;
  tx(db, () => {
    const insQuote = db.prepare(`
      INSERT OR IGNORE INTO quotes (at, name, dry, correlation_id, deposit_address, origin_asset, destination_asset, amount_in, amount_out, amount_in_usd, builder_fee_bps, warnings, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sdk')`);
    const upsertSwap = db.prepare(`
      INSERT INTO swaps (deposit_address, name, status, origin_asset, destination_asset, amount_in, amount_out, amount_in_usd, builder_fee_bps, app_fees, deposit_tx, sender, created_at, updated_at, source)
      VALUES (?, ?, 'PENDING_DEPOSIT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sdk')
      ON CONFLICT(deposit_address) DO UPDATE SET deposit_tx=COALESCE(excluded.deposit_tx, swaps.deposit_tx), sender=COALESCE(excluded.sender, swaps.sender), updated_at=excluded.updated_at`);
    const quoteByDeposit = new Map<string, Extract<BylineEvent, { kind: "quote" }>>();
    for (const e of events) {
      if (e.kind === "quote") {
        quotes += Number(
          insQuote.run(e.at, e.code, e.dry ? 1 : 0, e.correlationId ?? null, e.depositAddress ?? null, e.originAsset, e.destinationAsset, e.amountIn ?? null, e.amountOut ?? null, e.amountInUsd ? Number(e.amountInUsd) : null, e.builderFeeBps ?? 0, JSON.stringify(e.warnings)).changes,
        );
        if (!e.dry && e.depositAddress) quoteByDeposit.set(e.depositAddress, e);
      } else if (e.kind === "deposit") {
        const q = quoteByDeposit.get(e.depositAddress);
        upsertSwap.run(
          e.depositAddress, e.code, q?.originAsset ?? `nep141:${e.token}`, q?.destinationAsset ?? null, e.amount, q?.amountOut ?? null,
          q?.amountInUsd ? Number(q.amountInUsd) : null, q?.builderFeeBps ?? 0, JSON.stringify(q?.appFees ?? []), e.txHash, e.sender, e.at, e.at,
        );
        swaps++;
      } else if (e.kind === "transfer") {
        const onChain = verifiedByHash.get(e.txHash);
        // Count it only if the chain agrees: same signer, a byline memo for this name.
        if (onChain && onChain.transaction.signer_id === e.sender && parseMemoTransfers(onChain).some((m) => m.name === e.code)) {
          const ownerName = (db.prepare("SELECT name FROM accounts WHERE network = ? AND account_id = ?").get(ctx.network, e.sender) as { name: string } | undefined)?.name;
          transfers += insertTxs(db, ctx.network, ownerName ?? e.code, [onChain], "chain").memos;
        } else {
          ctx.log(`recorded: transfer ${e.txHash} not confirmed on ${ctx.network}; not counted`);
        }
      }
    }
    setCursor(db, key, String(lines.length));
  });
  ctx.log(`recorded: ${quotes} quotes, ${swaps} swaps, ${transfers} verified memo transfers`);
  return { quotes, swaps, transfers };
}

// ---------- 5. swap status from 1Click ----------

export async function syncSwapStatus(db: DatabaseSync, ctx: SyncContext): Promise<number> {
  const open = db
    .prepare(`SELECT deposit_address FROM swaps WHERE source != 'fixture' AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`)
    .all(...TERMINAL_STATUSES) as { deposit_address: string }[];
  let updated = 0;
  const upd = db.prepare(`
    UPDATE swaps SET status = ?, amount_in = COALESCE(?, amount_in), amount_out = COALESCE(?, amount_out),
      amount_in_usd = COALESCE(?, amount_in_usd), amount_out_usd = COALESCE(?, amount_out_usd),
      refund_reason = COALESCE(?, refund_reason), updated_at = ? WHERE deposit_address = ?`);
  for (const { deposit_address } of open) {
    try {
      const s = await ctx.oneClick.status(deposit_address);
      const d = (s.swapDetails ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
      upd.run(
        s.status, (d.amountIn as string) ?? null, (d.amountOut as string) ?? null, num(d.amountInUsd), num(d.amountOutUsd),
        (d.refundReason as string) ?? null, now(), deposit_address,
      );
      updated++;
    } catch (e) {
      ctx.log(`status: ${deposit_address}: ${(e as Error).message}`);
    }
    await ctx.sleep(1_000);
  }
  ctx.log(`status: ${updated}/${open.length} open swaps refreshed`);
  return updated;
}

// ---------- 6. Explorer API (needs a partner JWT) ----------

interface ExplorerTx {
  depositAddress: string;
  depositMemo?: string | null;
  status: SwapStatus;
  createdAt: string;
  referral: string;
  originAsset: string;
  destinationAsset: string;
  amountIn: string;
  amountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  appFees: { recipient: string; fee: number }[];
  nearTxHashes?: string[];
  senders?: string[];
  refundReason?: string | null;
}

/** Every 1Click swap with `referral=<name>`, including ones not made through our SDK. 1 request / 5 s. */
export async function syncExplorer(db: DatabaseSync, ctx: SyncContext): Promise<number> {
  if (ctx.network !== "mainnet") {
    // 1Click settles on mainnet and a referral is just a name, so only mainnet bylines own swap history.
    ctx.log("explorer: skipped on testnet (swaps belong to mainnet bylines)");
    return 0;
  }
  if (!ctx.explorerJwt) {
    ctx.log("explorer: skipped (no EXPLORER_JWT); swaps come from SDK records + 1Click status");
    return 0;
  }
  const bylines = db.prepare("SELECT name, payout, fee_bps FROM bylines WHERE network = ? AND source != 'fixture'").all(ctx.network) as {
    name: string;
    payout: string | null;
    fee_bps: number;
  }[];
  const upsert = db.prepare(`
    INSERT INTO swaps (deposit_address, name, status, origin_asset, destination_asset, amount_in, amount_out, amount_in_usd, amount_out_usd, builder_fee_bps, app_fees, deposit_tx, sender, refund_reason, created_at, updated_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'explorer')
    ON CONFLICT(deposit_address) DO UPDATE SET status=excluded.status, amount_in=excluded.amount_in, amount_out=excluded.amount_out,
      amount_in_usd=excluded.amount_in_usd, amount_out_usd=excluded.amount_out_usd, builder_fee_bps=excluded.builder_fee_bps,
      app_fees=excluded.app_fees, refund_reason=excluded.refund_reason, updated_at=excluded.updated_at`);
  let n = 0;
  for (const b of bylines) {
    let last: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ referral: b.name, numberOfTransactions: "1000" });
      if (last) {
        q.set("lastDepositAddress", last);
        q.set("direction", "next");
      }
      const res = await ctx.fetch(`${EXPLORER_API}/transactions?${q}`, { headers: { authorization: `Bearer ${ctx.explorerJwt}` } });
      if (!res.ok) throw new Error(`Explorer ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = (await res.json()) as ExplorerTx[];
      tx(db, () => {
        for (const r of rows) {
          // The builder's real share is whatever 1Click recorded for the payout.
          const bps = (r.appFees ?? []).filter((f) => f.recipient === b.payout).reduce((sum, f) => sum + f.fee, 0);
          upsert.run(
            r.depositAddress, b.name, r.status, r.originAsset, r.destinationAsset, r.amountIn, r.amountOut, Number(r.amountInUsd) || null,
            Number(r.amountOutUsd) || null, bps, JSON.stringify(r.appFees ?? []), r.nearTxHashes?.[0] ?? null, r.senders?.[0] ?? null,
            r.refundReason ?? null, r.createdAt, now(),
          );
          n++;
        }
      });
      await ctx.sleep(5_200);
      if (rows.length < 1000) break;
      last = rows.at(-1)!.depositAddress;
    }
  }
  ctx.log(`explorer: ${n} swaps upserted`);
  return n;
}

// ---------- 7. fee balances inside intents.near ----------

/** Payout balances on intents.near (mainnet), where 1Click credits app fees. */
export async function syncIntentsBalances(db: DatabaseSync, ctx: SyncContext): Promise<number> {
  const payouts = (db.prepare("SELECT DISTINCT payout FROM bylines WHERE payout IS NOT NULL AND source != 'fixture'").all() as { payout: string }[]).map((r) => r.payout);
  let n = 0;
  for (const payout of payouts) {
    if (!(await ctx.payoutChecker.canReceive(payout))) continue;
    const tokenIds: string[] = [];
    for (let from = 0; ; from += 100) {
      const page = (await ctx.mainnet.view<{ token_id: string }[]>("intents.near", "mt_tokens_for_owner", { account_id: payout, from_index: String(from), limit: 100 })) ?? [];
      tokenIds.push(...page.map((t) => t.token_id));
      if (page.length < 100) break;
    }
    const balances = tokenIds.length
      ? ((await ctx.mainnet.view<string[]>("intents.near", "mt_batch_balance_of", { account_id: payout, token_ids: tokenIds })) ?? [])
      : [];
    const at = now();
    tx(db, () => {
      db.prepare("DELETE FROM intents_balances WHERE payout = ? AND source = 'chain'").run(payout);
      const ins = db.prepare("INSERT OR REPLACE INTO intents_balances (payout, token_id, amount, synced_at, source) VALUES (?, ?, ?, ?, 'chain')");
      tokenIds.forEach((id, i) => {
        if (balances[i] && balances[i] !== "0") {
          ins.run(payout, id, balances[i], at);
          n++;
        }
      });
    });
  }
  ctx.log(`intents balances: ${n} non-zero balances across ${payouts.length} payouts`);
  return n;
}

// ---------- all ----------

export async function syncAll(db: DatabaseSync, ctx: SyncContext, opts: { recordedPath?: string } = {}) {
  await syncRegistry(db, ctx);
  await syncRegistryEvents(db, ctx);
  await syncActivity(db, ctx);
  if (opts.recordedPath) await ingestRecorded(db, ctx, opts.recordedPath);
  await syncExplorer(db, ctx);
  await syncSwapStatus(db, ctx);
  await syncIntentsBalances(db, ctx);
}
