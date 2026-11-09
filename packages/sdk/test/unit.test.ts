import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { generateKey, parsePublicKey } from "near-kit";
import type { Near } from "near-kit";
import {
  assertQuoteMatches,
  Byline,
  bylineMemo,
  checkPow,
  solvePow,
  codeForKey,
  codeFromSeed,
  createByline,
  signRegistration,
  verifyRegistration,
  isValidCode,
  mainnetPayoutChecker,
  OneClick,
  parseBylineMemo,
  Registry,
  resolveAttribution,
  toRawAmount,
  withByline,
  type BylineEvent,
  type PayoutChecker,
} from "../src/index.js";
import { FastNear } from "../src/chain.js";
import { memoryRateStore, Relayer, registerMessageProblem, upstashRateStore } from "../src/relay.js";

// ---------- fakes ----------

interface SentTx {
  signer: string;
  actions: { contract: string; method: string; args: Record<string, unknown>; opts: Record<string, unknown> }[];
}

function fakeNear(views: Record<string, (args: Record<string, unknown>, contract: string) => unknown>, existing: string[] = []) {
  const sent: SentTx[] = [];
  const calls: { contract: string; method: string; args: unknown; opts: unknown }[] = [];
  const near = {
    view: vi.fn(async (contract: string, method: string, args: Record<string, unknown> = {}) => {
      const f = views[method];
      if (!f) throw new Error(`unexpected view ${method}`);
      return f(args, contract);
    }),
    call: vi.fn(async (contract: string, method: string, args: unknown, opts: unknown) => {
      calls.push({ contract, method, args, opts });
      return true;
    }),
    accountExists: vi.fn(async (id: string) => existing.includes(id)),
    getAccount: vi.fn(async (id: string) => {
      if (id === "flaky.near") throw new Error("fetch failed");
      if (!existing.includes(id)) throw new Error(`Account ${id} does not exist`);
      return { amount: "1" };
    }),
    transaction: (signer: string) => {
      const tx: SentTx = { signer, actions: [] };
      const builder = {
        functionCall(contract: string, method: string, args: Record<string, unknown>, opts: Record<string, unknown>) {
          tx.actions.push({ contract, method, args, opts });
          return builder;
        },
        async send() {
          sent.push(tx);
          return { transaction_outcome: { id: `tx${sent.length}` } };
        },
      };
      return builder;
    },
  };
  return { near: near as unknown as Near, sent, calls, raw: near };
}

const TOKENS = [
  { assetId: "nep141:usdc.near", decimals: 6, blockchain: "near", symbol: "USDC" },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR" },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH" },
];

function fakeOneClick() {
  const requests: { path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("https://1click.chaindefuser.com/v0", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (path === "/tokens") return json(TOKENS);
    if (path === "/quote")
      return json(
        {
          correlationId: "c1",
          quoteRequest: body,
          quote: {
            amountIn: body.amount,
            amountInFormatted: "1.0",
            amountInUsd: "1.00",
            amountOut: "270000000000000000000000",
            amountOutFormatted: "0.27",
            ...(body.dry ? {} : { depositAddress: "a".repeat(64) }),
          },
        },
        201,
      );
    if (path === "/deposit/submit") return json({});
    if (path.startsWith("/status")) return json({ status: "SUCCESS" });
    return json({ message: "not found" }, 404);
  });
  return { oneClick: new OneClick({ fetch: fetchImpl as unknown as typeof fetch }), requests };
}

const record = (over: Record<string, unknown> = {}) => ({
  code: "k7m2x9qa",
  owner: "alice.near",
  payout: "alice.near",
  fee_bps: 40,
  account: "k7m2x9qa.byline.near",
  account_pending: false,
  linked: [],
  invited: [],
  created_at_ms: 1,
  title: null,
  description: null,
  ...over,
});

const okChecker: PayoutChecker = { canReceive: async () => true };

// ---------- names & memos ----------

describe("codes", () => {
  it("match the contract's rules", () => {
    expect(isValidCode("k7m2x9qa")).toBe(true);
    expect(isValidCode("acme-trader")).toBe(false);
    expect(isValidCode("k7m2x9q")).toBe(false);
    expect(isValidCode("k7m2x9qi")).toBe(false); // i isn't in the alphabet
    expect(isValidCode("K7M2X9QA")).toBe(false);
  });

  it("builds and parses memos", () => {
    expect(bylineMemo("k7m2x9qa")).toBe("byline:k7m2x9qa");
    expect(bylineMemo("k7m2x9qa", "inv-42")).toBe("byline:k7m2x9qa inv-42");
    expect(parseBylineMemo("byline:k7m2x9qa inv-42")).toBe("k7m2x9qa");
    expect(parseBylineMemo("byline:acme-trader")).toBeNull(); // chosen names are not codes
    expect(parseBylineMemo("hello")).toBeNull();
    expect(parseBylineMemo(null)).toBeNull();
    expect(() => bylineMemo("Bad!")).toThrow(/Invalid byline code/);
  });

  it("converts human amounts", () => {
    expect(toRawAmount("1", 6)).toBe("1000000");
    expect(toRawAmount("1.5", 6)).toBe("1500000");
    expect(toRawAmount("0.000001", 6)).toBe("1");
    expect(() => toRawAmount("0.0000001", 6)).toThrow();
    expect(() => toRawAmount("-1", 6)).toThrow();
  });
});

// ---------- attribution ----------

describe("withByline", () => {
  it("adds referral and fees", () => {
    const out = withByline({ amount: "1" }, { referral: "k7m2x9qa", appFees: [{ recipient: "alice.near", fee: 40 }] });
    expect(out).toEqual({ amount: "1", referral: "k7m2x9qa", appFees: [{ recipient: "alice.near", fee: 40 }] });
  });

  it("keeps the app's own fees and appends the byline's", () => {
    const out = withByline(
      { appFees: [{ recipient: "app.near", fee: 10 }] },
      { referral: "k7m2x9qa", appFees: [{ recipient: "alice.near", fee: 40 }] },
    );
    expect(out.appFees).toEqual([
      { recipient: "app.near", fee: 10 },
      { recipient: "alice.near", fee: 40 },
    ]);
  });

  it("omits appFees when there are none", () => {
    expect(withByline({}, { referral: "k7m2x9qa", appFees: [] })).toEqual({ referral: "k7m2x9qa" });
  });

  it("refuses a second byline on the same quote", () => {
    expect(() => withByline({ referral: "other" }, { referral: "k7m2x9qa", appFees: [] })).toThrow(/only one byline/);
  });
});

describe("resolveAttribution", () => {
  const registryWith = (attribution: unknown) =>
    new Registry({ network: "testnet", near: fakeNear({ get_attribution: () => attribution }).near });

  it("passes a fee to a payout that exists on mainnet", async () => {
    const r = registryWith({ referral: "k7m2x9qa", app_fees: [{ recipient: "alice.near", fee: 40 }] });
    const a = await resolveAttribution(r, "k7m2x9qa", okChecker);
    expect(a).toEqual({ code: "k7m2x9qa", referral: "k7m2x9qa", appFees: [{ recipient: "alice.near", fee: 40 }], warnings: [] });
  });

  it("drops the fee but keeps the referral when the payout can't receive", async () => {
    const r = registryWith({ referral: "k7m2x9qa", app_fees: [{ recipient: "byline.testnet", fee: 40 }] });
    const a = await resolveAttribution(r, "k7m2x9qa", mainnetPayoutChecker(fakeNear({}).near));
    expect(a.referral).toBe("k7m2x9qa");
    expect(a.appFees).toEqual([]);
    expect(a.warnings[0]).toMatch(/byline.testnet doesn't exist on NEAR mainnet/);
  });

  it("throws for an unknown byline", async () => {
    await expect(resolveAttribution(registryWith(null), "zzzzzzzz", okChecker)).rejects.toThrow(/No byline "zzzzzzzz"/);
  });
});

describe("builderShare", () => {
  it("reads the payout's share from 1Click's echoed fees", async () => {
    const { builderShare } = await import("../src/index.js");
    const echoed = {
      quoteRequest: { appFees: [{ recipient: "alice.near", fee: 20 }, { recipient: "f".repeat(64), fee: 20 }] },
      quote: {},
    } as any;
    expect(builderShare({ appFees: [{ recipient: "alice.near", fee: 40 }] }, echoed)).toBe(20);
    expect(builderShare({ appFees: [] }, echoed)).toBe(0);
  });
});

describe("mainnetPayoutChecker", () => {
  it("accepts implicit accounts, rejects .testnet, checks and caches the rest", async () => {
    const f = fakeNear({}, ["alice.near"]);
    const c = mainnetPayoutChecker(f.near);
    expect(await c.canReceive("f".repeat(64))).toBe(true);
    expect(await c.canReceive("x.testnet")).toBe(false);
    expect(await c.canReceive("alice.near")).toBe(true);
    expect(await c.canReceive("alice.near")).toBe(true);
    expect(await c.canReceive("ghost.near")).toBe(false);
    expect(await c.canReceive("ghost.near")).toBe(false);
    // alice cached after one read; ghost's "missing" cached for a while.
    expect(f.raw.getAccount).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache an RPC failure as 'missing'", async () => {
    const f = fakeNear({}, []);
    const c = mainnetPayoutChecker(f.near);
    expect(await c.canReceive("flaky.near")).toBe(false);
    expect(await c.canReceive("flaky.near")).toBe(false);
    expect(f.raw.getAccount).toHaveBeenCalledTimes(2);
  });
});

// ---------- Byline ----------

function makeByline(opts: { network?: "mainnet" | "testnet"; registered?: boolean } = {}) {
  const events: BylineEvent[] = [];
  const f = fakeNear({
    get_attribution: () => ({ referral: "k7m2x9qa", app_fees: [{ recipient: "alice.near", fee: 40 }] }),
    get_byline: () => record(),
    get_byline_for_account: () => null,
    storage_balance_of: () => (opts.registered ? { total: "1", available: "0" } : null),
  });
  const oc = fakeOneClick();
  const byline = new Byline({
    code: "k7m2x9qa",
    network: opts.network ?? "mainnet",
    near: f.near,
    oneClick: oc.oneClick,
    payoutChecker: okChecker,
    recorder: (e) => {
      events.push(e);
    },
  });
  return { byline, events, ...f, ...oc };
}

describe("Byline.quote", () => {
  it("is dry by default and carries the byline", async () => {
    const { byline, requests, events } = makeByline();
    const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "1" });
    const sent = requests.find((r) => r.path === "/quote")!.body;
    expect(sent.dry).toBe(true);
    expect(sent.referral).toBe("k7m2x9qa");
    expect(sent.appFees).toEqual([{ recipient: "alice.near", fee: 40 }]);
    expect(sent.amount).toBe("1000000");
    expect(sent.recipient).toBe("k7m2x9qa.byline.near");
    expect(sent.refundTo).toBe("k7m2x9qa.byline.near");
    expect(q.dry).toBe(true);
    expect(q.builderFeeBps).toBe(40); // the fake echoes the request unchanged
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "quote", code: "k7m2x9qa", dry: true, referral: "k7m2x9qa" });
  });

  it("finds destination tokens on other chains", async () => {
    const { byline, requests } = makeByline();
    await byline.quote({ from: "USDC", to: "ETH", toChain: "eth", amount: "1", recipient: "0xabc", refundTo: "alice.near" });
    const sent = requests.find((r) => r.path === "/quote")!.body;
    expect(sent.destinationAsset).toBe("nep141:eth.omft.near");
    expect(sent.recipient).toBe("0xabc");
  });
});

describe("Byline.swap", () => {
  it("only previews without { live: true }", async () => {
    const { byline, sent, requests } = makeByline();
    const r = await byline.swap({ from: "USDC", to: "wNEAR", amount: "1" });
    expect(r.executed).toBe(false);
    expect(sent).toHaveLength(0);
    expect(requests.find((x) => x.path === "/quote")!.body.dry).toBe(true);
  });

  it("refuses live swaps on testnet", async () => {
    const { byline } = makeByline({ network: "testnet" });
    await expect(byline.swap({ from: "USDC", to: "wNEAR", amount: "1" }, { live: true })).rejects.toThrow(/mainnet/);
  });

  it("live: commits, registers storage, deposits with the memo, submits", async () => {
    const { byline, sent, requests, events } = makeByline();
    const r = await byline.swap({ from: "USDC", to: "wNEAR", amount: "1" }, { live: true });
    expect(r.executed).toBe(true);
    expect(r.depositAddress).toBe("a".repeat(64));
    expect(sent).toHaveLength(1);
    const [storage, transfer] = sent[0]!.actions;
    expect(storage).toMatchObject({ contract: "usdc.near", method: "storage_deposit" });
    expect(transfer).toMatchObject({
      contract: "usdc.near",
      method: "ft_transfer",
      args: { receiver_id: "a".repeat(64), amount: "1000000", memo: "byline:k7m2x9qa" },
    });
    expect(requests.find((x) => x.path === "/deposit/submit")!.body).toEqual({
      txHash: "tx1",
      depositAddress: "a".repeat(64),
      nearSenderAccount: "k7m2x9qa.byline.near",
    });
    expect(events.map((e) => e.kind)).toEqual(["quote", "deposit"]);
  });

  it("refuses live swaps from tokens that aren't on NEAR", async () => {
    const { byline } = makeByline();
    await expect(byline.swap({ from: "ETH", to: "wNEAR", amount: "1" }, { live: true })).rejects.toThrow(/no token "ETH" on near/);
  });
});

describe("Byline.transfer and link", () => {
  it("adds the memo and skips storage when already registered", async () => {
    const { byline, sent, events } = makeByline({ network: "testnet", registered: true });
    const r = await byline.transfer({ token: "usdc.fakes.testnet", receiverId: "bob.testnet", amountRaw: "5", note: "inv-1" });
    expect(r.memo).toBe("byline:k7m2x9qa inv-1");
    expect(sent[0]!.actions).toHaveLength(1);
    expect(sent[0]!.actions[0]).toMatchObject({ method: "ft_transfer", args: { memo: "byline:k7m2x9qa inv-1" } });
    expect(events[0]).toMatchObject({ kind: "transfer", receiver: "bob.testnet", txHash: "tx1" });
  });

  it("links as the agent's account", async () => {
    const { byline, calls } = makeByline({ network: "testnet" });
    await byline.link();
    expect(calls[0]).toMatchObject({
      contract: "byline.testnet",
      method: "link_account",
      args: { code: "k7m2x9qa" },
      opts: { signerId: "k7m2x9qa.byline.near" },
    });
  });

  it("never lets a failing recorder break the agent", async () => {
    const f = fakeNear({
      get_attribution: () => ({ referral: "k7m2x9qa", app_fees: [] }),
      get_byline: () => record(),
    });
    const byline = new Byline({
      code: "k7m2x9qa",
      near: f.near,
      oneClick: fakeOneClick().oneClick,
      payoutChecker: okChecker,
      recorder: () => {
        throw new Error("disk full");
      },
    });
    await expect(byline.quote({ from: "USDC", to: "wNEAR", amount: "1" })).resolves.toBeTruthy();
  });
});

describe("generateAgentKey", () => {
  it("writes a 600 key file, returns only the public key, never overwrites", async () => {
    const { mkdtemp, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { generateAgentKey } = await import("../src/node.js");
    const dir = await mkdtemp(join(tmpdir(), "byline-keys-"));
    const r = await generateAgentKey("k7m2x9qa.byline.testnet", "testnet", dir);
    expect(r.publicKey).toMatch(/^ed25519:/);
    expect(Object.keys(r)).toEqual(["publicKey", "path"]);
    const file = JSON.parse(await readFile(r.path, "utf8"));
    expect(file.account_id).toBe("k7m2x9qa.byline.testnet");
    expect(file.public_key).toBe(r.publicKey);
    expect((await stat(r.path)).mode & 0o777).toBe(0o600);
    await expect(generateAgentKey("k7m2x9qa.byline.testnet", "testnet", dir)).rejects.toThrow();
  });
});

// ---------- onboarding (gasless) ----------

describe("FastNear read limits", () => {
  // A fake history API: every page holds 200 fresh transactions, so only the limits can stop the reader.
  const endless = () => {
    let pages = 0;
    let batches = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v0/account")) {
        const start = 1_000_000 - pages * 200;
        pages++;
        const account_txs = Array.from({ length: 200 }, (_, i) => ({ account_id: "a.testnet", transaction_hash: `h${start - i}`, tx_block_height: start - i, is_signer: false, is_real_signer: false }));
        return new Response(JSON.stringify({ account_txs }));
      }
      batches++;
      const { tx_hashes } = JSON.parse(String(init!.body)) as { tx_hashes: string[] };
      return new Response(JSON.stringify({ transactions: tx_hashes.map(() => null) }));
    });
    return { fast: new FastNear({ fetch: fetchImpl as unknown as typeof fetch }), pages: () => pages, batches: () => batches };
  };

  it("stops at the page cap and says it was cut short", async () => {
    const e = endless();
    const report = { truncated: false };
    const txs = await e.fast.accountTxs("testnet", "a.testnet", 0, { maxPages: 3, report });
    expect(e.pages()).toBe(3);
    expect(txs).toHaveLength(600);
    expect(report.truncated).toBe(true);
  });

  it("reads nothing more once the deadline has passed", async () => {
    const e = endless();
    const report = { truncated: false };
    await e.fast.accountTxs("testnet", "a.testnet", 0, { deadline: Date.now() - 1, report });
    await e.fast.transactions("testnet", Array.from({ length: 100 }, (_, i) => `h${i}`), { deadline: Date.now() - 1, report });
    expect(e.pages()).toBe(0);
    expect(e.batches()).toBe(0);
    expect(report.truncated).toBe(true);
  });
});

describe("Registry.inviteAccount", () => {
  it("refuses to invite an account that doesn't exist yet, unless told to", async () => {
    const f = fakeNear({}, ["bot.testnet"]);
    const r = new Registry({ network: "testnet", near: f.near, signerId: "builder.testnet" });
    await expect(r.inviteAccount("k7m2x9qa", "ghost.testnet")).rejects.toThrow(/doesn't exist on testnet/);
    expect(f.calls).toHaveLength(0);
    await r.inviteAccount("k7m2x9qa", "bot.testnet");
    await r.inviteAccount("k7m2x9qa", "ghost.testnet", { allowMissing: true });
    expect(f.calls.map((c) => [c.method, (c.args as { account_id: string }).account_id])).toEqual([
      ["invite_account", "bot.testnet"],
      ["invite_account", "ghost.testnet"],
    ]);
  });
});

describe("gasless onboarding", () => {
  const FIXTURE = JSON.parse(readFileSync(new URL("../../../fixtures/nep413-register.json", import.meta.url), "utf8"));

  it("derives the same code as the contract for a key", async () => {
    const pk = parsePublicKey(FIXTURE.agent_a.public_key).data;
    expect(await codeForKey(pk)).toBe(FIXTURE.agent_a.expected_code);
    expect(await codeFromSeed(new TextEncoder().encode("byline:v2:alice.near:0"))).toBe(FIXTURE.tx_path_codes["alice.near:0"]);
  });

  it("verifies near-kit-signed registrations, and only for the right registry", async () => {
    const reg = { public_key: FIXTURE.agent_a.public_key, message: FIXTURE.agent_a.message, nonce: FIXTURE.agent_a.nonce, signature: FIXTURE.agent_a.signature };
    expect(await verifyRegistration(reg, "byline.testnet")).toBe(true);
    expect(await verifyRegistration(reg, "byline.near")).toBe(false);
    expect(await verifyRegistration({ ...reg, message: reg.message.replace("A", "B") }, "byline.testnet")).toBe(false);
  });

  it("signs a register message the relayer and contract accept", async () => {
    const key = generateKey();
    const reg = signRegistration(key, "byline.testnet", { title: "Bot", payout: undefined });
    const msg = JSON.parse(reg.message);
    expect(msg).toMatchObject({ action: "register", title: "Bot" });
    expect("payout" in msg).toBe(false); // the contract rejects unknown or null fields, so empty ones are left out
    expect(msg.expires_at_ms - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await verifyRegistration(reg, "byline.testnet")).toBe(true);
  });

  function fakeRegistry(state: { keys: Record<string, string>; used: number; limit: number; submitted: unknown[] }, network: "testnet" | "mainnet" = "testnet") {
    const near = {
      view: vi.fn(async (_c: string, method: string, args: Record<string, unknown>) => {
        if (method === "get_byline_for_key") return state.keys[args.public_key as string] ?? null;
        if (method === "get_sponsor_status") return { used: state.used, limit: state.limit, seed: "30000000000000000000000" };
        throw new Error(method);
      }),
    } as unknown as Near;
    const registry = new Registry({ network, near });
    registry.registerSigned = vi.fn(async (reg) => {
      state.submitted.push(reg);
      state.keys[reg.public_key] = "k7m2x9qa";
      state.used++;
      return "txhash";
    });
    return registry;
  }

  it("relayer: verifies, submits once, and is idempotent per key", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), powBits: 0 });
    const reg = signRegistration(generateKey(), "byline.testnet", {});
    const first = await relayer.handle(reg, "1.1.1.1");
    expect(first).toEqual({ status: 200, body: { code: "k7m2x9qa", account_id: "k7m2x9qa.byline.testnet", tx_hash: "txhash", existing: false } });
    const again = await relayer.handle(reg, "1.1.1.1");
    expect(again.body).toMatchObject({ code: "k7m2x9qa", existing: true });
    expect(state.submitted).toHaveLength(1);
  });

  it("relayer: refuses bad signatures, wrong registry, expired messages, junk", async () => {
    const state = { keys: {}, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), powBits: 0 });
    const key = generateKey();
    expect((await relayer.handle({ nope: 1 })).status).toBe(400);
    expect((await relayer.handle(signRegistration(key, "byline.near", {}))).status).toBe(401);
    expect((await relayer.handle(signRegistration(key, "byline.testnet", {}, -1000))).body.error).toMatch(/expired/);
    expect((await relayer.handle(signRegistration(key, "byline.testnet", {}, 2 * 60 * 60_000))).body.error).toMatch(/too long/);
    expect(state.submitted).toHaveLength(0);
  });

  it("relayer: refuses, before paying gas, any message the registry would reject", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), powBits: 0 });
    const bad = [
      { fee_bps: 9999 },
      { fee_bps: 1.5 },
      { title: "é".repeat(33) }, // 66 bytes: the contract counts bytes, not characters
      { description: "x".repeat(281) },
      { payout: "Not An Account" },
      { surprise: true } as Record<string, unknown>,
    ];
    for (const fields of bad) {
      const r = await relayer.handle(signRegistration(generateKey(), "byline.testnet", fields as never), "1.1.1.1");
      expect(r.status, JSON.stringify(fields)).toBe(400);
    }
    // A message that parses to null, or a body that isn't an object, is a clean 400 too.
    const key = generateKey();
    const ok = signRegistration(key, "byline.testnet", {});
    expect((await relayer.handle({ ...ok, message: "null" }, "1.1.1.1")).status).toBe(400);
    expect((await relayer.handle("nope", "1.1.1.1")).status).toBe(400);
    expect(state.submitted).toHaveLength(0);
    expect(registerMessageProblem({ action: "register", expires_at_ms: Date.now() + 60_000, title: "é".repeat(32), fee_bps: 100 })).toBeNull();
  });

  it("relayer: submits a signed body at most once, even if the registry refuses it", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const registry = fakeRegistry(state);
    registry.registerSigned = vi.fn(async (reg) => {
      state.submitted.push(reg);
      throw new Error("Smart contract panicked: something on-chain");
    });
    const relayer = new Relayer({ network: "testnet", registry, powBits: 0 });
    const reg = signRegistration(generateKey(), "byline.testnet", {});
    expect((await relayer.handle(reg, "1.1.1.1")).status).toBe(400);
    expect((await relayer.handle(reg, "2.2.2.2")).status).toBe(409);
    expect(state.submitted).toHaveLength(1);
    // Only the four signed fields go on-chain, whatever else the request carried.
    expect(Object.keys(state.submitted[0] as object).sort()).toEqual(["message", "nonce", "public_key", "signature"]);
  });

  it("relayer: onboards one agent at a time and caps registrations per hour overall", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const registry = fakeRegistry(state);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = registry.registerSigned;
    registry.registerSigned = vi.fn(async (reg) => {
      await gate;
      return inner(reg);
    });
    const relayer = new Relayer({ network: "testnet", registry, powBits: 0, globalPerHour: 2 });
    const first = relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "1.1.1.1");
    await new Promise((r) => setTimeout(r, 10));
    const second = await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "2.2.2.2");
    expect(second).toMatchObject({ status: 503, body: { retry_after_s: 5 } });
    release();
    expect((await first).status).toBe(200);
    expect((await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "3.3.3.3")).status).toBe(200);
    expect((await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "4.4.4.4")).status).toBe(429);
  });

  it("createByline: trusts the registry, not the relayer, for the code and account", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const registry = fakeRegistry(state);
    const lying = vi.fn(async () => new Response(JSON.stringify({ code: "zzzzzzzz", account_id: "../../stolen" }), { status: 200 }));
    await expect(createByline({ network: "testnet", registry, fetch: lying as unknown as typeof fetch, relayerUrl: "http://relayer", powBits: 0 })).rejects.toThrow(/registry holds nothing/);
  });

  it("relayer: rate-limits per address and respects the sponsor quota", async () => {
    const state = { keys: {}, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), perIpPerHour: 2, powBits: 0 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "9.9.9.9")).status);
    expect(statuses).toEqual([200, 200, 429]);

    const full = new Relayer({ network: "testnet", registry: fakeRegistry({ keys: {}, used: 100, limit: 100, submitted: [] }), powBits: 0 });
    const r = await full.handle(signRegistration(generateKey(), "byline.testnet", {}), "8.8.8.8");
    expect(r).toMatchObject({ status: 429, body: { error: "Sponsored onboarding is full" } });
  });

  it("createByline: posts the signed message and returns the code; reuses an existing byline", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const registry = fakeRegistry(state);
    const relayer = new Relayer({ network: "testnet", registry, powBits: 8 });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const r = await relayer.handle(JSON.parse(String(init!.body)), "1.2.3.4");
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
    const key = generateKey();
    const created = await createByline({ network: "testnet", keyPair: key, title: "Bot", registry, fetch: fetchImpl as unknown as typeof fetch, relayerUrl: "http://relayer", powBits: 8 });
    expect(created).toMatchObject({ code: "k7m2x9qa", accountId: "k7m2x9qa.byline.testnet", existing: false, txHash: "txhash" });
    const again = await createByline({ network: "testnet", keyPair: key, registry, fetch: fetchImpl as unknown as typeof fetch, relayerUrl: "http://relayer" });
    expect(again.existing).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("relayer: asks new registrations for proof-of-work (428) and accepts a solved one", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), powBits: 10 });
    const reg = signRegistration(generateKey(), "byline.testnet", {});
    expect(await relayer.handle(reg, "1.1.1.1")).toMatchObject({ status: 428, body: { pow_bits: 10 } });
    expect((await relayer.handle({ ...reg, pow: "nope" }, "1.1.1.1")).status).toBe(428);
    expect(state.submitted).toHaveLength(0);
    const ok = await relayer.handle({ ...reg, pow: await solvePow(reg.signature, 10) }, "1.1.1.1");
    expect(ok.status).toBe(200);
    // A solution is bound to its signature: it doesn't carry over to another registration
    // (unless by a 1-in-1024 fluke, which the check below accounts for).
    const powA = await solvePow(reg.signature, 10);
    const other = signRegistration(generateKey(), "byline.testnet", {});
    const reused = await relayer.handle({ ...other, pow: powA }, "1.1.1.1");
    expect(reused.status).toBe(checkPow(other.signature, powA, 10) ? 200 : 428);
  });

  it("assertQuoteMatches: refuses a quote that differs from the request", () => {
    const request = {
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:wrap.near", depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:usdc", amount: "1000", recipient: "me.near", recipientType: "DESTINATION_CHAIN",
      refundTo: "me.near", refundType: "ORIGIN_CHAIN", deadline: "2026-01-01T00:00:00Z", referral: "k7m2x9qa",
    } as const;
    const good = { quoteRequest: { ...request }, quote: { amountIn: "1000", amountInFormatted: "", amountOut: "1", amountOutFormatted: "" } };
    expect(() => assertQuoteMatches({ ...request }, good)).not.toThrow();
    expect(() => assertQuoteMatches({ ...request }, { ...good, quote: { ...good.quote, amountIn: "5000" } })).toThrow(/amountIn 5000/);
    expect(() => assertQuoteMatches({ ...request }, { ...good, quoteRequest: { ...request, recipient: "evil.near" } })).toThrow(/recipient/);
    expect(() => assertQuoteMatches({ ...request }, { ...good, quoteRequest: { ...request, referral: "other" } })).toThrow(/referral/);
  });

  it("createByline: re-solves at the difficulty the relayer asks for", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const registry = fakeRegistry(state);
    const relayer = new Relayer({ network: "testnet", registry, powBits: 9 });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const r = await relayer.handle(JSON.parse(String(init!.body)), "1.2.3.4");
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
    const created = await createByline({ network: "testnet", registry, fetch: fetchImpl as unknown as typeof fetch, relayerUrl: "http://relayer", powBits: 2 });
    expect(created.existing).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("relayer: shares rate-limit counts through a store (Upstash REST)", async () => {
    // A tiny Upstash stand-in: SET (with NX), INCR and DEL, single commands at the root and batches at /pipeline.
    const values = new Map<string, number>();
    const calls: { path: string; body: unknown }[] = [];
    const run = (cmd: (string | number)[]) => {
      if (cmd[0] === "INCR") {
        values.set(String(cmd[1]), (values.get(String(cmd[1])) ?? 0) + 1);
        return values.get(String(cmd[1]));
      }
      if (cmd[0] === "DEL") return Number(values.delete(String(cmd[1])));
      if (cmd[0] === "SET") {
        if (cmd.includes("NX") && values.has(String(cmd[1]))) return null;
        values.set(String(cmd[1]), Number(cmd[2]));
        return "OK";
      }
      return null;
    };
    const fakeUpstash = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init!.body)) as unknown;
      calls.push({ path, body });
      if (path === "/pipeline") return new Response(JSON.stringify((body as (string | number)[][]).map((c) => ({ result: run(c) }))));
      return new Response(JSON.stringify({ result: run(body as (string | number)[]) }));
    });
    const store = upstashRateStore("https://example.upstash.io", "token", fakeUpstash as unknown as typeof fetch);
    const mk = () => new Relayer({ network: "testnet", registry: fakeRegistry({ keys: {}, used: 0, limit: 100, submitted: [] }), perIpPerHour: 1, powBits: 0, rateStore: store });
    // Two separate relayer instances (like two serverless instances) see the same count.
    expect((await mk().handle(signRegistration(generateKey(), "byline.testnet", {}), "7.7.7.7")).status).toBe(200);
    expect((await mk().handle(signRegistration(generateKey(), "byline.testnet", {}), "7.7.7.7")).status).toBe(429);
    // The counter gets its expiry in the same request as its first count.
    expect(calls).toContainEqual({ path: "/pipeline", body: [["SET", "byline:rate:byline.testnet:ip:7.7.7.7", "0", "PX", 3_600_000, "NX"], ["INCR", "byline:rate:byline.testnet:ip:7.7.7.7"]] });
  });

  it("relayer: testnet traffic never uses up mainnet's hourly cap (one shared store)", async () => {
    const store = memoryRateStore();
    const testnet = new Relayer({ network: "testnet", registry: fakeRegistry({ keys: {}, used: 0, limit: 100, submitted: [] }), powBits: 0, perIpPerHour: 100, globalPerHour: 2, rateStore: store });
    const mainnet = new Relayer({ network: "mainnet", registry: fakeRegistry({ keys: {}, used: 0, limit: 100, submitted: [] }, "mainnet"), powBits: 0, perIpPerHour: 100, globalPerHour: 2, rateStore: store });
    for (let i = 0; i < 3; i++) await testnet.handle(signRegistration(generateKey(), "byline.testnet", {}), `10.0.0.${i}`);
    expect((await mainnet.handle(signRegistration(generateKey(), "byline.near", {}), "10.0.1.1")).status).toBe(200);
  });

  it("relayer: replays and refusals don't count toward the hourly cap", async () => {
    const state = { keys: {} as Record<string, string>, used: 0, limit: 100, submitted: [] as unknown[] };
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry(state), powBits: 0, perIpPerHour: 100, globalPerHour: 2 });
    const reg = signRegistration(generateKey(), "byline.testnet", {});
    expect((await relayer.handle(reg, "1.1.1.1")).status).toBe(200);
    // Same body again: answered "existing" (key already has a byline) without counting.
    for (let i = 0; i < 6; i++) expect((await relayer.handle(reg, "1.1.1.1")).status).toBe(200);
    expect((await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "2.2.2.2")).status).toBe(200);
    expect(state.submitted).toHaveLength(2);
  });

  it("relayer: one solved body can't be replayed without end", async () => {
    const relayer = new Relayer({ network: "testnet", registry: fakeRegistry({ keys: {}, used: 100, limit: 100, submitted: [] }), powBits: 0 });
    const reg = signRegistration(generateKey(), "byline.testnet", {});
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await relayer.handle(reg, `3.3.3.${i}`)).status);
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });

  it("relayer: fails closed when the rate store is down", async () => {
    const relayer = new Relayer({
      network: "testnet",
      registry: fakeRegistry({ keys: {}, used: 0, limit: 100, submitted: [] }),
      powBits: 0,
      rateStore: { hit: async () => Promise.reject(new Error("down")) },
    });
    expect((await relayer.handle(signRegistration(generateKey(), "byline.testnet", {}), "1.1.1.1")).status).toBe(503);
  });

  it("createByline: surfaces the relayer's reason", async () => {
    const registry = fakeRegistry({ keys: {}, used: 100, limit: 100, submitted: [] });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Sponsored onboarding is full" }), { status: 429 }));
    await expect(
      createByline({ network: "testnet", registry, fetch: fetchImpl as unknown as typeof fetch, relayerUrl: "http://relayer", powBits: 0 }),
    ).rejects.toThrow(/Sponsored onboarding is full/);
  });
});
