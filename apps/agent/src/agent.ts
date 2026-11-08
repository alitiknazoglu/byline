#!/usr/bin/env node
/**
 * byline-agent: a small scripted DCA agent built on @bylinecode/sdk.
 *
 * Each round it quotes USDC → wNEAR through NEAR Intents with its byline attached, decides whether
 * the price is good enough to buy, and records everything for the indexer. Nothing moves by default.
 *
 *   --rounds N        rounds to run (default 3)
 *   --interval S      seconds between rounds (default 4)
 *   --amount X        USDC per round (default 1)
 *   --create          no byline yet? onboard gaslessly: new key, registry pays, code saved to data/agent.json
 *   --code CODE       act as this byline (default: the one in data/agent.json)
 *   --title TEXT      label for a new byline (with --create)
 *   --network NET     registry network, testnet | mainnet (default testnet)
 *   --recipient ID    mainnet account for dry quotes (default "near"; 1Click needs an existing mainnet account)
 *   --pay             also send one real testnet memo payment (0.001 wNEAR) signed by the agent's own account
 *   --live --yes      mainnet only: really swap (max 5 USDC per round). Never the default.
 *
 * Optional: NEARAI_API_KEY makes the agent explain each decision with NEAR AI Cloud (private, TEE-signed inference).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Byline, RELAYER_URLS, REGISTRY_IDS, type NetworkId, type QuoteResult } from "@bylinecode/sdk";
import { createAgentByline, jsonlRecorder, nearFromCredentials } from "@bylinecode/sdk/node";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(resolve(REPO, ".env"));
} catch {
  /* optional */
}

// ---------- flags ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback;
};

const network = opt("network", process.env.NEAR_NETWORK ?? "testnet") as NetworkId;
const rounds = Math.max(1, Number(opt("rounds", "3")));
const intervalMs = Math.max(0, Number(opt("interval", "4"))) * 1000;
const amount = opt("amount", "1");
const recipient = opt("recipient", "near");
const pay = flag("pay");
const live = flag("live");
const MAX_LIVE_USDC = 5;

if (network !== "testnet" && network !== "mainnet") throw new Error(`--network must be testnet or mainnet`);
if (live) {
  if (network !== "mainnet") fail("--live only works with --network mainnet: 1Click settles on NEAR mainnet.");
  if (!flag("yes")) fail("--live moves real funds. Add --yes to confirm you mean it.");
  if (Number(amount) > MAX_LIVE_USDC) fail(`--live is capped at ${MAX_LIVE_USDC} USDC per round.`);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- output ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const gold = (s: string) => `\x1b[33m${s}\x1b[0m`;
const say = (s = "") => console.log(s);

// ---------- optional: NEAR AI Cloud explains the decision ----------

async function explain(prompt: string): Promise<{ text: string; chatId: string } | null> {
  const key = process.env.NEARAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V3.1",
        max_tokens: 80,
        messages: [
          { role: "system", content: "You are a cautious DCA trading agent. Explain your decision in one plain sentence, no hype." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id: string; choices: { message: { content: string } }[] };
    return { text: j.choices[0]?.message.content.trim() ?? "", chatId: j.id };
  } catch {
    return null;
  }
}

// ---------- the agent ----------

/** The agent remembers its own byline here between runs. */
const AGENT_FILE = resolve(REPO, "data", `agent-${network}.json`);

async function identity(): Promise<{ code: string; accountId: string; created?: boolean }> {
  const explicit = opt("code", "");
  const registry = process.env.REGISTRY_CONTRACT_ID || REGISTRY_IDS[network];
  if (explicit) return { code: explicit, accountId: `${explicit}.${registry}` };
  const saved = await readFile(AGENT_FILE, "utf8").then((t) => JSON.parse(t) as { code: string; accountId: string }, () => null);
  if (saved && !flag("create")) return saved;
  if (!flag("create")) fail(`No byline yet. Run with --create to onboard this agent gaslessly (or pass --code).`);

  say(bold("onboarding") + dim("  new key → signed register message → relayer → registry pays"));
  const relayerUrl = process.env.BYLINE_RELAYER_URL || RELAYER_URLS[network];
  const created = await createAgentByline({
    network,
    registryId: process.env.REGISTRY_CONTRACT_ID || undefined,
    relayerUrl,
    title: opt("title", "Byline demo DCA agent"),
    description: "Scripted DCA agent from the Byline repo: quotes USDC → wNEAR every round, credited to its code.",
  });
  say(`  code          ${gold(created.code)}`);
  say(`  account       ${created.accountId} ${dim("(created and funded by the registry; only this agent's key controls it)")}`);
  say(`  key           ${created.keyFile.replace(homedir(), "~")}`);
  if (created.txHash) say(`  tx            ${network === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io"}/txns/${created.txHash}`);
  say();
  const id = { code: created.code, accountId: created.accountId };
  await mkdir(resolve(REPO, "data"), { recursive: true });
  await writeFile(AGENT_FILE, JSON.stringify({ ...id, network }, null, 2) + "\n");
  return { ...id, created: true };
}

async function main() {
  const { code, accountId } = await identity();
  const keyFile = join(homedir(), ".near-credentials", network, `${accountId}.json`);
  const hasKey = existsSync(keyFile);
  const recordPath = resolve(REPO, "data", "byline-events.jsonl");
  const byline = new Byline({
    code,
    network,
    accountId,
    ...(hasKey ? { near: nearFromCredentials(accountId, network) } : {}),
    recorder: jsonlRecorder(recordPath),
  });

  say(bold(`byline-agent · ${code} · ${network}`));
  const attribution = await byline.attribution();
  say(`  credited as   ${gold(`referral: "${attribution.referral}"`)}`);
  say(`  fees          ${attribution.appFees.length ? attribution.appFees.map((f) => `${f.fee} bps → ${f.recipient}`).join(", ") : "none attached"}`);
  for (const w of attribution.warnings) say(dim(`  note          ${w}`));
  say(`  mode          ${live ? gold("LIVE: real swaps on mainnet") : "dry: quotes only, nothing is sent"}`);
  say();

  let best = Infinity; // best USDC-per-wNEAR price seen so far
  let wouldBuy = 0;
  for (let round = 1; round <= rounds; round++) {
    const q: QuoteResult = live
      ? await byline.swap({ from: "USDC", to: "wNEAR", amount }, { live: true })
      : await byline.quote({ from: "USDC", to: "wNEAR", amount, recipient, refundTo: recipient });
    const out = Number(q.response.quote.amountOutFormatted);
    const price = Number(amount) / out;
    // A simple DCA rule: buy every round, but flag a round whose price is more than 1% worse than the best seen.
    const ok = price <= best * 1.01;
    best = Math.min(best, price);
    if (ok) wouldBuy++;

    say(`${bold(`round ${round}/${rounds}`)}  ${amount} USDC → ${out.toFixed(4)} wNEAR  ${dim(`(${price.toFixed(4)} USDC/wNEAR)`)}`);
    say(`  decision      ${ok ? (live ? "bought" : "would buy") : "skip: price moved more than 1% against the best this run"}`);
    say(`  credited      ${gold(`referral "${q.request.referral}"`)}, builder share ${q.builderFeeBps} bps${q.dry ? dim("  (dry quote, recorded)") : ""}`);
    if ("depositAddress" in q && (q as { depositAddress?: string }).depositAddress) say(`  deposit       ${(q as { depositAddress?: string }).depositAddress}`);

    const why = await explain(
      `Round ${round}. Quote: ${amount} USDC buys ${out} wNEAR (price ${price.toFixed(4)}). Best price this run: ${best.toFixed(4)}. Decision: ${ok ? "buy" : "skip"}.`,
    );
    if (why) say(`  why           ${why.text} ${dim(`[NEAR AI Cloud, verifiable chat ${why.chatId}]`)}`);

    if (round < rounds && intervalMs) await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (pay) await payOnce(byline, accountId, hasKey);

  say();
  say(bold("done"));
  say(`  ${rounds} quotes credited to ${code}${live ? "" : " (dry)"}, ${wouldBuy} ${live ? "buys" : "would-buys"}`);
  say(`  recorded to   ${recordPath}`);
  say(dim("  next: npm run index   (syncs the indexer and refreshes the site snapshot)"));
}

/** One real testnet NEP-141 payment with memo byline:<code>, signed by the agent itself. */
async function payOnce(byline: Byline, accountId: string, hasKey: boolean) {
  say();
  if (network !== "testnet") return say(dim("  pay           skipped: --pay is a testnet demo"));
  if (!hasKey) return say(dim(`  pay           skipped: no key for ${accountId} in ~/.near-credentials/testnet`));
  const near = byline.near;
  const wrap = "wrap.testnet";
  const amountRaw = "1000000000000000000000"; // 0.001 wNEAR
  const bal = BigInt((await near.view<string>(wrap, "ft_balance_of", { account_id: accountId }).catch(() => "0")) ?? "0");
  if (bal < BigInt(amountRaw)) {
    let tx = near.transaction(accountId);
    if (!(await near.view(wrap, "storage_balance_of", { account_id: accountId }))) {
      tx = tx.functionCall(wrap, "storage_deposit", { account_id: accountId, registration_only: true }, { gas: "10 Tgas", attachedDeposit: "0.00125 NEAR" });
    }
    await tx.functionCall(wrap, "near_deposit", {}, { gas: "10 Tgas", attachedDeposit: "0.002 NEAR" }).send({ waitUntil: "FINAL" });
  }
  const { txHash, memo } = await byline.transfer({ token: wrap, receiverId: "byline.testnet", amountRaw, note: "dca-fee" });
  say(`${bold("payment")}  0.001 wNEAR → byline.testnet, memo ${gold(`"${memo}"`)}`);
  say(`  tx            https://testnet.nearblocks.io/txns/${txHash}`);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message ?? e}`);
  process.exit(1);
});
