/** Every command the terminal understands. Each returns what it prints. */
import type { ReactNode } from "react";
import { Near, generateKey, isValidAccountId } from "near-kit";
import { Byline, DEFAULT_FEE_BPS, isValidCode, MAX_FEE_BPS, OneClick, OneClickError, Registry } from "@by-line/sdk";
import { FastNear, parseMemoTransfers, parseTx } from "@by-line/sdk/chain";
import { accountUrl, ago, count, dateTime, formatAmount, loadSnapshot, short, tokenSymbol, txUrl, usd, type Detail, type Room, type Row, type Snapshot } from "./data";
import { Cmd, Code, CodeRef, Err, Ext, Gap, Head, Json, KV, Line, Ok, Table, Trace, Warn, type Col, type Step } from "./ui";
import { prefersReducedMotion } from "./clearing";
import type { WalletState } from "./wallet";

import { agentAccount, DEMO_CODE, IS_MAINNET, NETWORK, OTHER_NETWORK, OTHER_SITE, REGISTRY, WRAP } from "./network";
export { DEMO_CODE, REGISTRY };

export interface Ctx {
  args: string[];
  flags: Record<string, string | true>;
  room: Room;
  setRoom: (r: Room) => void;
  wallet: WalletState;
  /** Update the "working…" line while a command runs. */
  status: (text: string) => void;
  /** Replace the command's output while it runs (progress that turns into the result). */
  live: (node: ReactNode) => void;
  /** Queue another command after this one (e.g. verify what was just sent). */
  then: (line: string) => void;
}

export interface Command {
  usage: string;
  summary: string;
  run: (c: Ctx) => Promise<ReactNode> | ReactNode;
}

const readRegistry = new Registry({ network: NETWORK });
const readNear = new Near({ network: NETWORK });
const fastnear = new FastNear();
const oneClick = new OneClick();

/** Splits a command line into words, honouring quotes, and pulls out --flags. */
export function parse(line: string): { name: string; args: string[]; flags: Record<string, string | true> } {
  const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
  const [name = "", ...rest] = words;
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w.startsWith("--")) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[w.slice(2)] = next;
        i++;
      } else flags[w.slice(2)] = true;
    } else args.push(w);
  }
  return { name: name.toLowerCase(), args, flags };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

async function snapshot(room: Room): Promise<Snapshot> {
  const s = await loadSnapshot(room);
  if (!s) throw new Error(room === "mainnet" ? "mainnet isn't live yet: the registry opens at byline.near" : `no ${room} snapshot found yet`);
  return s;
}

async function findDetail(code: string, room: Room): Promise<{ d: Detail; snap: Snapshot; room: Room } | null> {
  for (const r of [room, ...([NETWORK, "sample"] as Room[]).filter((x) => x !== room)]) {
    const s = await loadSnapshot(r);
    const d = s?.details[code];
    if (s && d) return { d, snap: s, room: r };
  }
  return null;
}

// ---------- commands ----------

/** An account on this site's network, linked to NearBlocks. */
function AccountLink({ id }: { id: string }) {
  return <Ext href={accountUrl(NETWORK, id, false)!}>{id}</Ext>;
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * What `verify` was given: a bare tx hash, a NearBlocks tx link (testnet or mainnet), a 1Click deposit
 * address, or a NEAR Intents explorer link. Links are reduced to the hash or address inside them.
 */
function verifyTarget(raw: string): { target: string; isTx: boolean } {
  if (TX_HASH.test(raw)) return { target: raw, isTx: true };
  let url: URL | null = null;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    url = null;
  }
  const host = url?.hostname.replace(/^www\./, "") ?? "";
  if (url && host.endsWith("nearblocks.io")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const at = parts.findIndex((x) => x === "txns" || x === "tx");
    const hash = at >= 0 ? parts[at + 1] : undefined;
    if (!hash || !TX_HASH.test(hash)) {
      if (parts.includes("address")) throw new Error(`that's an account page; try show <code>, or open one of its transactions and verify that link`);
      throw new Error("couldn't find a transaction hash in that NearBlocks link (expected …/txns/<hash>)");
    }
    const linkNetwork = host.startsWith("testnet.") ? "testnet" : "mainnet";
    if (linkNetwork !== NETWORK) {
      throw new Error(`that's a ${linkNetwork} transaction; this site checks ${NETWORK}. Verify it at ${OTHER_SITE}`);
    }
    return { target: hash, isTx: true };
  }
  if (url && host === "explorer.near-intents.org") {
    const address = url.pathname.split("/").filter(Boolean).pop();
    if (!address || address === "transactions") throw new Error("couldn't find a deposit address in that explorer link");
    return { target: address, isTx: false };
  }
  return { target: raw, isTx: false };
}

/** Keys made by `account <code>`, kept in this tab until `--create` uses them. Never displayed. */
const pendingKeys = new Map<string, ReturnType<typeof generateKey>>();

/** Save a near-cli style key file. The link stays alive a minute so slow browsers finish the download. */
function downloadKey(accountId: string, key: ReturnType<typeof generateKey>) {
  const file = JSON.stringify({ account_id: accountId, public_key: key.publicKey.toString(), private_key: key.secretKey }, null, 2);
  const url = URL.createObjectURL(new Blob([file], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${accountId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, prefersReducedMotion() ? 0 : ms));

/**
 * A live checklist for a command: each step shows a spinner while its real check runs (held for a
 * moment so it can be followed), then its result. The final output keeps the finished checklist.
 */
function checklist(live: (node: ReactNode) => void, title: ReactNode) {
  let steps: Step[] = [];
  const show = (tail?: ReactNode) =>
    live(
      <>
        {title}
        <Trace steps={steps.map((x) => ({ ...x }))} />
        {tail}
      </>,
    );
  return {
    define(defs: [label: string, via: string][]) {
      steps = defs.map(([label, via]) => ({ label, via, state: "wait" }));
      show();
      return steps;
    },
    async step<T>(i: number, check: () => Promise<T>, result: (v: T) => Pick<Step, "state" | "detail">): Promise<T> {
      steps[i] = { ...steps[i]!, state: "run" };
      show();
      const [v] = await Promise.all([check(), pause(380)]);
      steps[i] = { ...steps[i]!, ...result(v) };
      show();
      return v;
    },
    /** The finished checklist plus the verdict; steps never reached are dropped. */
    verdict(node: ReactNode): ReactNode {
      steps = steps.filter((x) => x.state !== "wait");
      return (
        <>
          {title}
          <Trace steps={steps} />
          {node}
        </>
      );
    },
  };
}

/** What `register` (and its alias `onboard`) prints: the two ways to get a byline. */
function registerGuide(wallet: WalletState): ReactNode {
  return (
    <>
      <Line>Two ways to get a byline. Either way the registry generates the code; nobody picks it.</Line>
      <Head>an agent registers itself (free, no NEAR)</Head>
      <Line>
        It signs one message; the registry pays for its byline and its own funded account. Step by step for agents:{" "}
        <a href="/llms.txt" target="_blank" rel="noreferrer">
          /llms.txt
        </a>
      </Line>
      <Line tone="dim">from code (Node)</Line>
      <Code>{`import { createAgentByline } from "@by-line/sdk/node";

const agent = await createAgentByline({ network: "${NETWORK}", title: "My DCA bot" });
agent.code       // e.g. "${DEMO_CODE}": attach it to every swap and payment
agent.accountId  // "<code>.${REGISTRY}", funded by the registry, controlled by this key`}</Code>
      <Line tone="dim">from the repo</Line>
      <Code>{`npm run agent -- --create --pay        # uses the hosted relayer`}</Code>
      <Line tone="dim">
        from an MCP client: call <span className="t-code">byline_create</span> · setup in <Cmd>mcp</Cmd>
      </Line>
      <Head>a human registers from a wallet (0.01 NEAR for storage, the rest comes back)</Head>
      {wallet.accountId ? (
        <Line>
          connected as {wallet.accountId} · run <Cmd>register --wallet</Cmd> or <Cmd>{`register --wallet --title "My agent"`}</Cmd>
        </Line>
      ) : (
        <Line>
          <Cmd>connect</Cmd> a {NETWORK} wallet, then <Cmd>register --wallet</Cmd>
        </Line>
      )}
      <Line tone="dim">options: --title "Acme bot" · --payout you.near (a mainnet account gets the swap fees) · --fee 0–100 bps, default 40</Line>
    </>
  );
}

export const COMMANDS: Record<string, Command> = {
  help: {
    usage: "help",
    summary: "list every command",
    run: () => (
      <>
        <Table
          cols={[
            { head: "command", cell: (c: [string, Command]) => <Cmd>{c[1].usage.split(" ")[0]!}</Cmd> },
            { head: "usage", cell: (c) => <span className="t-dim">{c[1].usage}</span> },
            { head: "what it does", cell: (c) => c[1].summary },
          ]}
          rows={Object.entries(COMMANDS).filter(([k]) => k !== "clear" && k !== "onboard")}
        />
        <Line tone="dim">Keys: Tab completes · ↑ ↓ history · Ctrl+L clears instantly · click any code or command.</Line>
      </>
    ),
  },

  about: {
    usage: "about",
    summary: "what Byline is",
    run: () => (
      <>
        <Line>
          A <b>byline</b> is an AI agent's identity on the NEAR blockchain: a random code the registry contract {REGISTRY} generates, like <CodeRef code={DEMO_CODE} />.
        </Line>
        <Line>
          It's a soulbound NFT (NEP-171) with its own account and payout: it can't be sold or moved, and it earns the builder's fees.
        </Line>
        <Line />
        <Line>The agent attaches it to everything it does on NEAR, and that's how the chain knows who did what:</Line>
        <Line>
          {"> "}swaps - NEAR Intents (1Click) quotes carry it as the <span className="t-code">referral</span>, and pay the builder a fee share
        </Line>
        <Line>
          {"> "}payments - token transfers carry <span className="t-code">byline:&lt;code&gt;</span> in their memo
        </Line>
        <Line>
          {"> "}accounts - <span className="t-code">&lt;code&gt;.byline.near</span> can only be created by the registry, so whatever it signs counts
        </Line>
        <Line />
        <Line>
          Why it matters: every credit is public and permanent on NEAR, so an agent's record grows with each action. Over time
          that record becomes its trust score, the way a credit history works at a bank, except anyone can check it on-chain.
        </Line>
        <Line />
        <Line>An agent with nothing but a key onboards itself for free: it signs one message and the registry pays.</Line>
      </>
    ),
  },

  top: {
    usage: `top [--sort volume|fees|txs|counterparties] [--room ${NETWORK}|sample]`,
    summary: "the leaderboard of credited agents",
    run: async ({ flags, room }) => {
      const asked = str(flags.room);
      if (asked && asked !== NETWORK && asked !== "sample") throw new Error(`this site shows ${NETWORK}; ${OTHER_NETWORK} lives at ${OTHER_SITE}`);
      const r = (asked as Room) ?? room;
      const snap = await snapshot(r);
      const key = ({ volume: "volume_usd", fees: "builder_fees_usd", txs: "txs", counterparties: "counterparties" } as const)[
        (str(flags.sort) ?? "volume") as "volume"
      ];
      if (!key) throw new Error("--sort takes volume, fees, txs or counterparties");
      const rows = [...snap.rows].sort((a, b) => b[key] - a[key] || b.txs - a.txs);
      const cols: Col<Row>[] = [
        { head: "#", cell: (x) => <span className="t-dim">{rows.indexOf(x) + 1}</span> },
        { head: "code", cell: (x) => <CodeRef code={x.name} /> },
        { head: "agent", cell: (x) => x.title ?? <span className="t-dim">—</span> },
        { head: "swaps", cell: (x) => (x.swaps_failed ? `${x.swaps} (+${x.swaps_failed} refunded)` : count(x.swaps)), right: true },
        { head: "volume", cell: (x) => usd(x.volume_usd), right: true },
        { head: "builder fees", cell: (x) => usd(x.builder_fees_usd), right: true },
        { head: "txs", cell: (x) => count(x.txs), right: true },
        { head: "counterparties", cell: (x) => count(x.counterparties), right: true },
        { head: "payments", cell: (x) => count(x.memo_transfers), right: true },
        { head: "paid by", cell: (x) => count(x.memo_payers ?? 0), right: true },
      ];
      return (
        <>
          <Line tone="dim">
            {r === "sample"
              ? `SAMPLE data: made-up agents priced from a real recorded 1Click quote; nothing here is on-chain · indexed ${dateTime(snap.generatedAt)}`
              : `indexed from ${snap.registry} · ${ago(snap.generatedAt)} · refreshes every ~2 min`}{" "}
            · sorted by {str(flags.sort) ?? "volume"}
          </Line>
          <Table cols={cols} rows={rows} empty="No bylines yet. Be the first: register" />
        </>
      );
    },
  },

  use: {
    usage: `use ${NETWORK}|sample`,
    summary: "switch which collection top and show read",
    run: ({ args, setRoom }) => {
      const r = args[0] as Room;
      if (r === OTHER_NETWORK) throw new Error(`this site shows ${NETWORK}; ${OTHER_NETWORK} lives at ${OTHER_SITE}`);
      if (r !== NETWORK && r !== "sample") throw new Error(`use ${NETWORK} or use sample`);
      setRoom(r);
      return <Ok>now reading the {r} collection{r === "sample" ? " (made-up demo agents, clearly labelled)" : ""}</Ok>;
    },
  },

  show: {
    usage: "show <code>",
    summary: "one byline: accounts, credits, swaps, payments, history",
    run: async ({ args, room }) => {
      const code = args[0] ?? DEMO_CODE;
      const found = await findDetail(code, room);
      if (!found) throw new Error(`no byline ${code} in the snapshots. Codes look like ${DEMO_CODE}; try top`);
      const { d, snap } = found;
      const b = d.byline;
      const net = snap.network;
      const link = (h: string) => (b.sample ? short(h) : <Ext href={txUrl(net, h)}>{short(h)}</Ext>);
      return (
        <>
          <Line>
            <span className="t-code big">{b.name}</span> {b.title && <b>{b.title}</b>} {b.sample && <span className="tag">sample</span>}
          </Line>
          <KV
            rows={[
              ["own account", b.account],
              ["builder", b.owner],
              ["fees go to", b.payout],
              ["fee asked", `${b.fee_bps} bps (the builder keeps about ${Math.ceil(b.fee_bps / 2)})`],
              ["linked", d.accounts.filter((a) => a.kind === "linked").map((a) => a.account_id).join(", ") || null],
              ["credited", `${b.swaps} swaps · ${usd(b.volume_usd)} volume · ${usd(b.builder_fees_usd)} to the builder · ${b.txs} txs · ${b.memo_transfers} payments made · paid by ${b.memo_payers ?? 0} ${(b.memo_payers ?? 0) === 1 ? "account" : "accounts"}`],
            ]}
          />
          <Head n={d.swaps.length}>swaps</Head>
          <Table
            cols={[
              { head: "when", cell: (s) => <span className="t-dim">{dateTime(s.created_at)}</span> },
              { head: "swap", cell: (s) => `${formatAmount(s.amount_in, s.origin_asset)} → ${s.amount_out ? formatAmount(s.amount_out, s.destination_asset) : tokenSymbol(s.destination_asset)}` },
              { head: "usd", cell: (s) => usd(s.amount_in_usd), right: true },
              { head: "status", cell: (s) => <span className={s.status === "SUCCESS" ? "t-ok" : s.status.match(/REFUND|FAIL|INCOMPLETE/) ? "t-err" : "t-dim"}>{s.status.toLowerCase()}</span> },
            ]}
            rows={d.swaps.slice(0, 8)}
            empty={net === "testnet" ? "(none: 1Click settles on mainnet, so testnet agents show dry quotes)" : "(none yet)"}
          />
          <Head n={d.memoTransfers.length}>payments carrying byline:{b.name}</Head>
          <Table
            cols={[
              { head: "when", cell: (m) => <span className="t-dim">{dateTime(m.block_ts_ms)}</span> },
              { head: "amount", cell: (m) => formatAmount(m.amount, m.token) },
              { head: "from", cell: (m) => (d.accounts.some((a) => a.account_id === m.sender) ? <span className="t-dim">the agent</span> : m.sender) },
              { head: "to", cell: (m) => (d.accounts.some((a) => a.account_id === m.receiver) ? <span className="t-dim">the agent</span> : m.receiver) },
              { head: "memo", cell: (m) => <span className="t-code">{m.memo}</span> },
              { head: "tx", cell: (m) => link(m.tx_hash) },
            ]}
            rows={d.memoTransfers.slice(0, 8)}
          />
          <Head n={d.txs.length}>transactions its accounts signed</Head>
          <Table
            cols={[
              { head: "when", cell: (t) => <span className="t-dim">{dateTime(t.block_ts_ms)}</span> },
              { head: "call", cell: (t) => `${t.methods.split(",").join(" + ")} → ${t.receiver}` },
              { head: "", cell: (t) => <span className={t.success ? "t-ok" : "t-err"}>{t.success ? "ok" : "failed"}</span> },
              { head: "tx", cell: (t) => link(t.hash) },
            ]}
            rows={d.txs.slice(0, 8)}
          />
          <Head n={d.events.length}>registry history</Head>
          <Table
            cols={[
              { head: "when", cell: (e) => <span className="t-dim">{dateTime(e.block_ts_ms)}</span> },
              { head: "event", cell: (e) => e.event },
              {
                head: "detail",
                cell: (e) => {
                  const x = (JSON.parse(e.data) as Record<string, unknown>[])[0] ?? {};
                  return x.via === "signed" ? "onboarded itself with a signed message; the registry paid" : String(x.account_id ?? x.payout ?? x.owner_id ?? "");
                },
              },
            ]}
            rows={d.events.slice(0, 8)}
          />
          {d.quotes.length > 0 && (
            <>
              <Head n={d.quotes.length}>dry quotes</Head>
              <Line tone="dim">{`${d.quotes.length} previews with the code attached (never counted as volume). Run quote --code ${b.name} for a live one.`}</Line>
            </>
          )}
        </>
      );
    },
  },

  quote: {
    usage: "quote [amount] [from] [to] [--code CODE]",
    summary: "a live 1Click dry quote with the byline attached",
    run: async ({ args, flags, status }) => {
      const [amount = "1", from = "USDC", to = from.toUpperCase() === "USDC" ? "wNEAR" : "USDC"] = args;
      const code = str(flags.code) ?? DEMO_CODE;
      if (!isValidCode(code)) throw new Error(`${code} isn't a byline code (8 characters like ${DEMO_CODE})`);
      status(`asking 1Click for ${amount} ${from} → ${to}, credited to ${code}…`);
      const byline = new Byline({ code, network: NETWORK, oneClick });
      const q = await byline.quote({ from, to, amount, recipient: "near", refundTo: "near" });
      const { referral, appFees, ...rest } = q.request;
      const echoed = q.response.quoteRequest.appFees ?? [];
      return (
        <>
          <Ok>
            {amount} {from} → <b>{q.response.quote.amountOutFormatted.replace(/(\.\d{4})\d+/, "$1")} {to}</b>, credited to <CodeRef code={code} />
          </Ok>
          <Line>
            builder earns: {q.builderFeeBps ? <span className="t-code">{q.builderFeeBps} bps</span> : <span className="t-dim">not yet</span>}
            {echoed.length > 0 && <span className="t-dim"> · 1Click recorded {echoed.map((f) => `${f.fee} bps → ${short(f.recipient, 10, 4)}`).join(", ")}</span>}
          </Line>
          {q.attribution.warnings.map((w) => (
            <Warn key={w}>
              no fee attached yet: the payout isn't a NEAR mainnet account, and 1Click pays fees on mainnet. The swap is still credited through the referral.
            </Warn>
          ))}
          <Line tone="dim">dry quote: nothing was sent or signed. The request 1Click received (the byline's lines in amber):</Line>
          <Json value={{ referral, ...(appFees ? { appFees } : {}), ...rest }} mark={["referral", "appFees"]} />
        </>
      );
    },
  },

  verify: {
    usage: "verify <tx-hash|nearblocks-link|deposit-address|intents-explorer-link> [--code CODE]",
    summary: "is this transaction or swap credited to a byline? (checks it live, step by step; paste a NearBlocks link too)",
    run: async ({ args, flags, live }) => {
      if (!args[0]) throw new Error("verify <tx-hash>, a NearBlocks tx link, or a 1Click deposit address");
      const { target, isTx } = verifyTarget(args[0]);
      const want = str(flags.code);
      const run = checklist(live, <Line tone="dim">verifying {isTx ? "transaction" : "swap"} {short(target, 10, 8)}</Line>);

      if (isTx) {
        run.define([
          ["transaction", "tx.test.fastnear.com"],
          ["outcome", "receipts"],
          ["signer", `${REGISTRY} · get_byline_for_account`],
          ["memo", "ft_transfer args"],
          ["registry", `${REGISTRY} · get_byline`],
        ]);
        const t = await run.step(0, async () => (await fastnear.transactions(NETWORK, [target]))[0] ?? null, (t) =>
          t ? { state: "ok", detail: <>found · {parseTx(t).methods.join(" + ")} → <AccountLink id={parseTx(t).receiver} /></> } : { state: "fail", detail: `not on ${NETWORK}` },
        );
        if (!t) return run.verdict(<Err>not credited: that transaction isn't on {NETWORK}</Err>);
        const p = parseTx(t);
        await run.step(1, async () => p.success, (ok) => (ok ? { state: "ok", detail: "succeeded" } : { state: "fail", detail: "failed, so nothing counts" }));
        const signerCode = await run.step(2, () => readRegistry.getBylineForAccount(p.signer), (c) =>
          c ? { state: "ok", detail: <><AccountLink id={p.signer} /> is an account of <CodeRef code={c} /></> } : { state: "skip", detail: <><AccountLink id={p.signer} /> isn't linked to a byline</> },
        );
        const memos = await run.step(3, async () => parseMemoTransfers(t), (ms) =>
          ms.length ? { state: "ok", detail: <span className="t-code">{ms.map((m) => m.memo).join(", ")}</span> } : { state: "skip", detail: "no byline:<code> memo" },
        );
        const subject = want ?? signerCode ?? memos[0]?.name ?? null;
        const record = await run.step(4, async () => (subject ? readRegistry.getByline(subject) : null), (r) =>
          r ? { state: "ok", detail: <><CodeRef code={r.code} /> is registered{r.title ? ` · ${r.title}` : ""}</> } : { state: subject ? "fail" : "skip", detail: subject ? `no byline ${subject}` : "nothing to look up" },
        );
        const byCode = Boolean(subject) && (signerCode === subject || memos.some((m) => m.name === subject));
        const credited = byCode && p.success && Boolean(record);
        return run.verdict(
          <>
            {credited ? <Ok>credited to <CodeRef code={subject!} /></Ok> : <Err>not credited{subject ? ` to ${subject}` : " to any byline"}</Err>}
            <KV
              rows={[
                ["signer", <AccountLink id={p.signer} />],
                ["call", <>{p.methods.join(" + ")} → <AccountLink id={p.receiver} /></>],
                ["tx", <Ext href={txUrl(NETWORK, p.hash)}>{p.hash}</Ext>],
                ["registry", <AccountLink id={REGISTRY} />],
              ]}
            />
          </>,
        );
      }

      run.define([
        ["swap", "1click.chaindefuser.com · status"],
        ["referral", "echoed quote request"],
        ["registry", `${REGISTRY} · get_byline`],
      ]);
      const s = await run.step(
        0,
        async () => {
          try {
            return await oneClick.status(target);
          } catch (e) {
            if (e instanceof OneClickError && e.status === 404) return null;
            throw e;
          }
        },
        (s) => (s ? { state: "ok", detail: s.status.toLowerCase() } : { state: "fail", detail: "1Click has no swap with that deposit address" }),
      );
      if (!s) return run.verdict(<Err>not credited: 1Click doesn't know that deposit address</Err>);
      const referral = s.quoteResponse?.quoteRequest.referral ?? null;
      await run.step(1, async () => referral, (r) => (r ? { state: "ok", detail: <span className="t-code">{r}</span> } : { state: "fail", detail: "none" }));
      const record = await run.step(2, async () => (referral && isValidCode(referral) ? readRegistry.getByline(referral) : null), (r) =>
        r ? { state: "ok", detail: <><CodeRef code={r.code} /> is registered{r.title ? ` · ${r.title}` : ""}</> } : { state: referral ? "fail" : "skip", detail: referral ? `${referral} isn't a registered byline` : "nothing to look up" },
      );
      const ok = Boolean(record) && (!want || referral === want);
      return run.verdict(
        <>
          {ok ? <Ok>swap credited to <CodeRef code={referral!} /></Ok> : <Err>swap not credited{want ? ` to ${want}` : ""} (referral: {referral ?? "none"})</Err>}
          <KV rows={[["status", s.status.toLowerCase()], ["deposit", <Ext href={`https://explorer.near-intents.org/transactions/${target}`}>{target}</Ext>]]} />
        </>,
      );
    },
  },

  pay: {
    usage: IS_MAINNET ? "pay [--code CODE] [--to account.near] [--amount 0.01] [--yes]" : "pay [--code CODE] [--to account.testnet] [--amount 0.01]",
    summary: `send a real ${NETWORK} payment credited to a byline (wraps NEAR, memo byline:<code>), then verify it`,
    run: async ({ flags, wallet, status, then }) => {
      const code = str(flags.code) ?? DEMO_CODE;
      if (!isValidCode(code)) throw new Error(`"${code}" isn't a byline code (8 characters, like ${DEMO_CODE})`);
      const amount = str(flags.amount) ?? "0.01";
      const max = IS_MAINNET ? 0.1 : 1;
      if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > max) throw new Error(`--amount takes 0.000001 to ${max} (${NETWORK} NEAR)`);
      const record = await readRegistry.getByline(code);
      if (!record) throw new Error(`no byline ${code} on ${REGISTRY}`);
      const to = str(flags.to) ?? record.account ?? record.owner;
      // Checked, so the preview and the command it offers can't disagree about who gets paid.
      if (!isValidAccountId(to)) throw new Error(`--to must be a NEAR account id, got "${to}"`);
      const memo = `byline:${code} demo`;

      if (!wallet.accountId || !wallet.near) {
        return (
          <>
            <Line>
              Sends {amount} {IS_MAINNET ? "real" : "testnet"} NEAR from your wallet to <span className="t-code">{to}</span> as wNEAR, with the memo <span className="t-code">{memo}</span>, then checks it on-chain.
              {IS_MAINNET ? "On mainnet this is real money: you see a preview first, then confirm with --yes." : "Swaps settle on mainnet only, so on testnet a payment is the live demo."}
            </Line>
            <Line>
              <Cmd>connect</Cmd> a {NETWORK} wallet, then run <Cmd>{flags.code ? `pay --code ${code}` : "pay"}</Cmd> again
              {IS_MAINNET ? null : (
                <>
                  {" "}· no testnet NEAR? use the faucet at <Ext href="https://docs.near.org/faucet">docs.near.org/faucet</Ext>
                </>
              )}
            </Line>
          </>
        );
      }

      const sender = wallet.accountId;
      // Real money: show exactly what will happen and wait for an explicit --yes.
      if (IS_MAINNET && !flags.yes) {
        const again = ["pay", ...(flags.code ? ["--code", code] : []), ...(flags.to ? ["--to", to] : []), ...(flags.amount ? ["--amount", amount] : []), "--yes"].join(" ");
        return (
          <>
            <Warn>this sends real NEAR on mainnet</Warn>
            <KV
              rows={[
                ["from", sender],
                ["to", to],
                ["amount", `${amount} NEAR, wrapped to wNEAR`],
                ["memo", <span className="t-code">{memo}</span>],
                ["plus", "wNEAR storage for new holders (0.00125 NEAR each) and gas"],
              ]}
            />
            <Line>
              To send it, run <Cmd>{again}</Cmd> and approve in your wallet.
            </Line>
          </>
        );
      }
      const raw = (BigInt(amount.split(".")[0]!) * 10n ** 24n + BigInt((amount.split(".")[1] ?? "").padEnd(24, "0") || "0")).toString();
      status("checking wNEAR storage…");
      const [senderReg, receiverReg] = await Promise.all([
        readNear.view(WRAP, "storage_balance_of", { account_id: sender }),
        readNear.view(WRAP, "storage_balance_of", { account_id: to }),
      ]);
      // One transaction to the wNEAR contract: register if needed, wrap the NEAR, send it with the byline memo.
      let tx = wallet.near.transaction(sender);
      if (!senderReg) tx = tx.functionCall(WRAP, "storage_deposit", { account_id: sender, registration_only: true }, { gas: "10 Tgas", attachedDeposit: "0.00125 NEAR" });
      if (!receiverReg) tx = tx.functionCall(WRAP, "storage_deposit", { account_id: to, registration_only: true }, { gas: "10 Tgas", attachedDeposit: "0.00125 NEAR" });
      tx = tx
        .functionCall(WRAP, "near_deposit", {}, { gas: "10 Tgas", attachedDeposit: BigInt(raw) })
        .functionCall(WRAP, "ft_transfer", { receiver_id: to, amount: raw, memo }, { gas: "15 Tgas", attachedDeposit: "1 yocto" });
      status(`approve in your wallet: ${amount} NEAR → ${to}, memo "${memo}"…`);
      const outcome = (await tx.send({ waitUntil: "FINAL" })) as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } };
      const hash = outcome.transaction_outcome?.id ?? outcome.transaction?.hash;
      if (!hash) throw new Error("the wallet didn't return a transaction hash; check your wallet's activity");
      then(`verify ${hash}`);
      return (
        <>
          <Ok>
            sent {amount} wNEAR to {to} with memo <span className="t-code">{memo}</span>
          </Ok>
          <KV rows={[["tx", <Ext href={txUrl(NETWORK, hash)}>{hash}</Ext>]]} />
          <Line tone="dim">verifying it on-chain next…</Line>
        </>
      );
    },
  },

  sponsor: {
    usage: "sponsor",
    summary: "how many agents the registry has onboarded for free",
    run: async ({ status }) => {
      status("reading the registry…");
      const s = await readRegistry.getSponsorStatus();
      return (
        <Line>
          <span className="t-code">{s.used}</span> of {s.limit} free agent onboardings used on {NETWORK} · each agent account starts with {Number(BigInt(s.seed) / 10n ** 21n) / 1000} NEAR
        </Line>
      );
    },
  },

  onboard: {
    usage: "onboard",
    summary: "same as register (kept for old links)",
    run: (ctx) => registerGuide(ctx.wallet),
  },

  mcp: {
    usage: "mcp",
    summary: "use Byline from Claude Code, Cursor or any MCP client",
    run: () => (
      <>
        <Line>Register the Byline MCP server (it's on npm as @by-line/mcp; nothing to clone):</Line>
        <Code>{`{
  "mcpServers": {
    "byline": {
      "command": "npx",
      "args": ["-y", "@by-line/mcp@0.2.0"],
      "env": { "BYLINE_NETWORK": "${NETWORK}" }
    }
  }
}`}</Code>
        <Table
          cols={[
            { head: "tool", cell: (t: string[]) => <span className="t-code">{t[0]}</span> },
            { head: "what", cell: (t) => t[1] },
          ]}
          rows={[
            ["byline_create", "free identity: new key, signed message, registry pays (destructive: permanent)"],
            ["byline_info", "owner, payout, fee, and what quotes will carry"],
            ["byline_quote", "live 1Click quote, always dry"],
            ["byline_swap", "previews unless confirm=true on mainnet with BYLINE_ALLOW_LIVE=1"],
            ["byline_pay", "payment with memo byline:<code>"],
            ["byline_activity", "what the agent's accounts signed, live"],
            ["byline_verify", "is this tx or swap credited?"],
            ["byline_link", "credit another account (both keys local)"],
            ["byline_register_with_wallet", "register from a funded account"],
          ]}
        />
        <Line tone="dim">Audited with mcprobe: 90/100 (A), every malformed input rejected cleanly.</Line>
      </>
    ),
  },

  connect: {
    usage: "connect",
    summary: `connect a ${NETWORK} wallet (for register --wallet)`,
    run: async ({ wallet, status }) => {
      if (wallet.accountId) return <Ok>already connected as {wallet.accountId}</Ok>;
      status("waiting for your wallet…");
      const id = await wallet.connect();
      if (!id) throw new Error(wallet.error ?? "the wallet didn't connect");
      return (
        <>
          <Ok>connected as {id} ({NETWORK})</Ok>
          <Line tone="dim">
            next: <Cmd>register --wallet</Cmd> · or <Cmd>{`register --wallet --title "My agent"`}</Cmd>
          </Line>
        </>
      );
    },
  },

  disconnect: {
    usage: "disconnect",
    summary: "disconnect the wallet",
    run: async ({ wallet }) => {
      await wallet.disconnect();
      return <Ok>disconnected</Ok>;
    },
  },

  whoami: {
    usage: "whoami",
    summary: "the connected wallet and its bylines",
    run: async ({ wallet, status }) => {
      if (!wallet.accountId) return <Line tone="dim">not connected · <Cmd>connect</Cmd></Line>;
      status("reading your bylines…");
      const mine = await readRegistry.getBylinesForOwner(wallet.accountId);
      return (
        <>
          <Line>{wallet.accountId} ({NETWORK})</Line>
          <Table
            cols={[
              { head: "code", cell: (b: (typeof mine)[number]) => <span className="t-code">{b.code}</span> },
              { head: "agent", cell: (b) => b.title ?? "—" },
              { head: "own account", cell: (b) => b.account ?? <Cmd>{`account ${b.code}`}</Cmd> },
            ]}
            rows={mine}
            empty="no bylines yet · register --wallet"
          />
        </>
      );
    },
  },

  register: {
    usage: 'register [--wallet] [--title "Acme bot"] [--payout acct.near] [--fee 40]',
    summary: "get a byline: an agent for free, or a human from a wallet (the registry picks the code)",
    run: async ({ wallet, flags, status }) => {
      if (!flags.wallet) return registerGuide(wallet);
      if (!wallet.accountId || !wallet.near) throw new Error("connect a wallet first: connect");
      const fee = flags.fee === undefined ? DEFAULT_FEE_BPS : Number(flags.fee);
      if (!Number.isInteger(fee) || fee < 0 || fee > MAX_FEE_BPS) throw new Error(`--fee takes 0 to ${MAX_FEE_BPS}`);
      const title = str(flags.title);
      if (title && title.length > 64) throw new Error("--title is at most 64 characters");
      const registry = new Registry({ network: NETWORK, near: wallet.near, signerId: wallet.accountId });
      const before = new Set((await readRegistry.getBylinesForOwner(wallet.accountId)).map((b) => b.code));
      status("approve the registration in your wallet (0.01 NEAR covers storage, the rest comes back)…");
      await registry.register({ ...(title ? { title } : {}), ...(str(flags.payout) ? { payout: str(flags.payout) } : {}), fee_bps: fee });
      const after = await readRegistry.getBylinesForOwner(wallet.accountId);
      const created = after.find((b) => !before.has(b.code));
      if (!created) throw new Error("the transaction went through but no new byline showed up yet; run whoami in a moment");
      return (
        <>
          <Ok>
            registered <span className="t-code big">{created.code}</span>, credited from now on
          </Ok>
          <Line tone="dim">
            give the agent its own account: <Cmd>{`account ${created.code}`}</Cmd> · attach the code to swaps: <Cmd>{`quote --code ${created.code}`}</Cmd>
          </Line>
        </>
      );
    },
  },

  account: {
    usage: "account <code> [--create] [--download]",
    summary: `create <code>.${REGISTRY} for a byline you registered (saves its key first, then creates)`,
    run: async ({ wallet, args, flags, status }) => {
      const code = args[0];
      if (!code || !isValidCode(code)) throw new Error("account <code> (one of yours: whoami)");
      if (!wallet.accountId || !wallet.near) throw new Error("connect a wallet first: connect");
      const accountId = agentAccount(code);
      const pending = pendingKeys.get(code);

      // Step 2: only once the key file is saved does any money move.
      if (flags.create) {
        if (!pending) throw new Error(`no saved key for ${code} in this tab yet: run account ${code} first`);
        status(`approve create_account in your wallet (0.05 NEAR funds ${accountId})…`);
        await new Registry({ network: NETWORK, near: wallet.near, signerId: wallet.accountId }).createAccount(code, pending.publicKey.toString(), "0.05 NEAR");
        pendingKeys.delete(code);
        return (
          <>
            <Ok>
              created {accountId}: everything it signs is credited to <span className="t-code">{code}</span>
            </Ok>
            <Line tone="dim">Move {accountId}.json to ~/.near-credentials/{NETWORK}/ and give it to the agent. It was never shown here.</Line>
          </>
        );
      }

      // Step 1: check, make the key, save it. Nothing is sent.
      status("checking the byline…");
      const record = await readRegistry.getByline(code);
      if (!record) throw new Error(`no byline ${code} on ${REGISTRY}`);
      if (record.owner !== wallet.accountId) throw new Error(`${code} belongs to ${record.owner}, not ${wallet.accountId}`);
      if (record.account) throw new Error(`${code} already has its account: ${record.account}`);
      // Reuse the key this tab already saved: a second run must not swap in a key the user doesn't hold.
      const key = pending ?? generateKey();
      pendingKeys.set(code, key);
      downloadKey(accountId, key);
      return (
        <>
          <Ok>key for {accountId} downloaded as {accountId}.json (never shown here)</Ok>
          <Line>
            Check the file is in your Downloads, then run <Cmd>{`account ${code} --create`}</Cmd> to create and fund the account (0.05 NEAR).
          </Line>
          <Line tone="dim">
            Didn't get the file? <Cmd>{`account ${code} --download`}</Cmd> saves the same key again.
          </Line>
        </>
      );
    },
  },

  clear: { usage: "clear", summary: "clear the screen and caches, then start a fresh session (same as the red button)", run: () => null },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);
