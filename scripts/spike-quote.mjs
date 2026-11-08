// Spike: does 1Click accept an agent ID as `referral`, plus `appFees`, on a dry quote, and echo them back?
// No keys, no funds: dry quotes only. Writes responses to fixtures/ for the no-keys demo.
// Usage: node scripts/spike-quote.mjs   (optional ONECLICK_JWT in env for the authenticated fee schedule)

import { writeFile, mkdir } from "node:fs/promises";

const API = "https://1click.chaindefuser.com/v0";
const headers = { "content-type": "application/json" };
if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;

// 1Click rejects NEAR recipients that don't exist on mainnet ("Internal server error"),
// so the dry quote uses well-known existing accounts as stand-ins. Nothing is ever paid.
const AGENT_ID = "demo-agent-1";           // candidate agent ID (valid as a 1Click referral and a NEAR label)
const PAYOUT = "near";                     // stand-in payout account (exists on mainnet)
const MISSING_PAYOUT = "payout-does-not-exist-7f3a.near";
const AGENT = "aurora";                    // stand-in recipient / refund (exists on mainnet)

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const tokens = await getJson(`${API}/tokens`);
if (tokens.status !== 200) throw new Error(`tokens ${tokens.status}: ${JSON.stringify(tokens.body)}`);
const find = (pred) => tokens.body.find(pred);
const usdcNear = find((t) => t.blockchain === "near" && t.symbol === "USDC");
const wnear = find((t) => t.blockchain === "near" && (t.symbol === "wNEAR" || t.assetId === "nep141:wrap.near"));
if (!usdcNear || !wnear) throw new Error("could not find USDC/wNEAR on near in /tokens");
console.log("assets:", usdcNear.assetId, "->", wnear.assetId);

const quoteReq = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: usdcNear.assetId,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: wnear.assetId,
  amount: String(10 ** usdcNear.decimals), // 1 USDC
  recipient: AGENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: AGENT,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

const cases = {
  plain: quoteReq,
  referral_only: { ...quoteReq, referral: AGENT_ID },
  referral_and_fee: { ...quoteReq, referral: AGENT_ID, appFees: [{ recipient: PAYOUT, fee: 25 }] },
  fee_to_missing_payout: { ...quoteReq, referral: AGENT_ID, appFees: [{ recipient: MISSING_PAYOUT, fee: 25 }] },
  bad_referral: { ...quoteReq, referral: "Bad Code!" },
};

await mkdir("fixtures", { recursive: true });
const summary = {};
for (const [name, req] of Object.entries(cases)) {
  const r = await getJson(`${API}/quote`, { method: "POST", headers, body: JSON.stringify(req) });
  await writeFile(`fixtures/quote-${name}.json`, JSON.stringify({ request: req, status: r.status, response: r.body }, null, 2));
  const q = r.body?.quote ?? {};
  summary[name] = {
    status: r.status,
    amountOut: q.amountOutFormatted ?? q.amountOut,
    echoedReferral: r.body?.quoteRequest?.referral ?? null,
    echoedAppFees: r.body?.quoteRequest?.appFees ?? null,
    error: r.status >= 400 ? r.body : undefined,
  };
}
console.log(JSON.stringify({ authenticated: Boolean(process.env.ONECLICK_JWT), summary }, null, 2));
