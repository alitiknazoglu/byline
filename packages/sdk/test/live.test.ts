/**
 * Live checks against the real registry on testnet, real 1Click (dry quotes only) and mainnet RPC.
 * No funds move unless LIVE_WRITE=1, and then only on testnet:
 * the demo agent sends 0.001 wNEAR to the registry with memo "byline:<code>".
 *
 *   npm run test:live -w @by-line/sdk
 *   LIVE_WRITE=1 npm run test:live -w @by-line/sdk   (needs the demo agent key: ~/.near-credentials/testnet/nw5s2ea1.byline.testnet.json)
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { describe, expect, it } from "vitest";
import { Byline, Registry, parseBylineMemo } from "../src/index.js";
import { jsonlRecorder, nearFromCredentials } from "../src/node.js";

/** The repo's demo agent: onboarded gaslessly, it owns its byline through its own account. */
const CODE = "nw5s2ea1";
const AGENT = "nw5s2ea1.byline.testnet";
// 1Click only accepts recipients that exist on mainnet; the testnet agent doesn't, so dry quotes use a stand-in.
const STAND_IN = "aurora";

describe("registry on testnet", () => {
  const registry = new Registry({ network: "testnet" });

  it("reads the demo agent's byline", async () => {
    const b = await registry.getByline(CODE);
    expect(b?.account).toBe(AGENT);
    expect(b?.owner).toBe(AGENT);
    expect(b?.sponsored).toBe(true);
    expect(await registry.getBylineForAccount(AGENT)).toBe(CODE);
    const s = await registry.getSponsorStatus();
    expect(s.used).toBeGreaterThanOrEqual(1);
  });
});

describe("Byline against live 1Click", () => {
  it("dry quote carries the referral; a testnet payout is not sent fees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byline-"));
    const log = join(dir, "events.jsonl");
    const byline = new Byline({ code: CODE, network: "testnet", recorder: jsonlRecorder(log) });

    const a = await byline.attribution();
    expect(a.referral).toBe(CODE);
    expect(a.appFees).toEqual([]);
    expect(a.warnings.join()).toMatch(/nw5s2ea1.byline.testnet doesn't exist on NEAR mainnet/);

    const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "1", recipient: STAND_IN, refundTo: STAND_IN });
    expect(q.dry).toBe(true);
    expect(q.response.quoteRequest.referral).toBe(CODE);
    expect(BigInt(q.response.quote.amountOut)).toBeGreaterThan(0n);

    const lines = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "quote", code: CODE, dry: true, referral: CODE });
  }, 30_000);

  it("passes fees to a payout that exists on mainnet", async () => {
    const byline = new Byline({ code: CODE, network: "testnet" });
    const q = await byline.oneClick.quote(
      await byline.attach({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: (await byline.oneClick.token("USDC")).assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: "nep141:wrap.near",
        amount: "1000000",
        recipient: STAND_IN,
        recipientType: "DESTINATION_CHAIN",
        refundTo: STAND_IN,
        refundType: "ORIGIN_CHAIN",
        deadline: new Date(Date.now() + 600_000).toISOString(),
        appFees: [{ recipient: "near", fee: 10 }],
      }),
    );
    expect(q.quoteRequest.referral).toBe(CODE);
    // 1Click echoes the real split: part of the requested fee goes to the payout, plus its own entry.
    const toPayout = q.quoteRequest.appFees?.find((f) => f.recipient === "near");
    expect(toPayout?.fee).toBeGreaterThan(0);
    expect(toPayout!.fee).toBeLessThanOrEqual(10);
    console.log("1Click fee split for a 10 bps request:", JSON.stringify(q.quoteRequest.appFees));
  }, 30_000);
});

describe.runIf(process.env.LIVE_WRITE === "1")("testnet transfer with memo", () => {
  it("sends 0.001 wNEAR from the demo agent with byline:<code>", async () => {
    const near = nearFromCredentials(AGENT, "testnet");
    const byline = new Byline({ code: CODE, network: "testnet", near, accountId: AGENT });
    const amount = "1000000000000000000000"; // 0.001 wNEAR

    // Wrap a little NEAR first if the agent holds no wNEAR (registers its own storage too).
    const bal = await near.view<string>("wrap.testnet", "ft_balance_of", { account_id: AGENT }).catch(() => "0");
    if (BigInt(bal ?? "0") < BigInt(amount)) {
      let tx = near.transaction(AGENT);
      if (!(await near.view("wrap.testnet", "storage_balance_of", { account_id: AGENT }))) {
        tx = tx.functionCall("wrap.testnet", "storage_deposit", { account_id: AGENT, registration_only: true }, { gas: "10 Tgas", attachedDeposit: "0.00125 NEAR" });
      }
      await tx.functionCall("wrap.testnet", "near_deposit", {}, { gas: "10 Tgas", attachedDeposit: "0.002 NEAR" }).send({ waitUntil: "FINAL" });
    }

    const { txHash, memo } = await byline.transfer({ token: "wrap.testnet", receiverId: "byline.testnet", amountRaw: amount, note: "sdk-live-test" });
    expect(memo).toBe(`byline:${CODE} sdk-live-test`);
    console.log(`transfer tx: https://testnet.nearblocks.io/txns/${txHash}`);

    // Read the memo back from the chain, the way the indexer will.
    const rpc = new Near({ network: "testnet" });
    const status = (await rpc.getTransactionStatus(txHash, AGENT, "FINAL")) as any;
    const actions = status.transaction.actions as any[];
    const call = actions.map((a) => a.FunctionCall).find((f) => f?.method_name === "ft_transfer");
    const args = JSON.parse(Buffer.from(call.args, "base64").toString());
    expect(parseBylineMemo(args.memo)).toBe(CODE);
  }, 90_000);
});
