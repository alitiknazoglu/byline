---
name: byline
description: Give an AI agent a byline on NEAR, an on-chain identity code that credits every swap, payment and transaction to the agent and its builder and pays the builder a share of NEAR Intents swap fees. An agent with only a key can onboard itself for free. Use when the user wants an agent identity on NEAR, wants to attribute or track an agent's activity, wants to add a referral or app fee to NEAR Intents / 1Click quotes, or wants an agent account like <code>.byline.near.
---

# Give an agent a byline on NEAR

A **byline** is a random code the registry generates, such as `k7m2x9qa`, held as a non-transferable NFT in the registry (`byline.near` on mainnet, `byline.testnet` on testnet). The agent attaches it to everything it does, and that's how the chain knows who did what:

- **Swaps** through NEAR Intents (1Click) carry `referral: "<code>"` plus `appFees: [{ recipient: <payout>, fee }]`, so the builder earns part of the fee.
- **Token payments** carry the memo `byline:<code>`.
- **Its own account**, `<code>.byline.near`, can only be created by the registry, so every transaction it signs is provably the agent's.

The SDK is `@by-line/sdk`. The full rules are in `contract/RULES.md` of the Byline repo.

## Safety rules (always)

- **Never ask for or print a private key or seed phrase.** Keys are generated on disk (`createAgentByline`, `generateAgentKey`); only public keys are shown.
- **Start on testnet.** Go to mainnet only when the user asks; the user signs or approves every mainnet action.
- **Keep it dry by default.** `quote()` and `swap()` move nothing unless you pass `{ live: true }`, and never add that without the user's explicit go-ahead for that swap.
- **Use a payout that exists on NEAR mainnet,** because 1Click pays fees there. The SDK drops fees to missing payouts and warns. Tell the user; don't work around it.

## Easiest: use the Byline MCP server

If the agent runs in an MCP client (Claude Code, Claude Desktop, Cursor), register it with `npx -y @by-line/mcp@0.2.0` (it's on npm); `packages/mcp/README.md` has the config. It exposes these tools:
- **Identity:** `byline_create` (free) and `byline_info`;
- **Swaps:** `byline_quote` (always dry) and `byline_swap` (preview unless confirmed on mainnet);
- **Payments:** `byline_pay` (memo `byline:<code>`);
- **Linking:** `byline_link`;
- **Checks:** `byline_activity` and `byline_verify`.

The server tells the model the flow when it connects.

## Path A: the agent onboards itself (no NEAR needed)

Use this when the agent has nothing yet. It signs one message, and the registry pays for its byline and creates its funded account (sponsored, while the quota lasts).

```bash
npm install @by-line/sdk
```

```ts
import { createAgentByline } from "@by-line/sdk/node";

const agent = await createAgentByline({
  network: "testnet",
  title: "Acme DCA bot",                  // human-readable label
  payout: "acme-team.near",               // optional: pay fees to the human (a mainnet account); default is the agent's own account
  // relayerUrl: "http://localhost:8787/register",  // when running the repo's relayer locally (`npm run relayer`)
});
agent.code;       // e.g. "k7m2x9qa"
agent.accountId;  // "k7m2x9qa.byline.testnet": created and funded by the registry, controlled only by this key
agent.keyFile;    // ~/.near-credentials/testnet/k7m2x9qa.byline.testnet.json (mode 600, near-cli layout)
```

- **Safe to retry:** pass `keyFile: agent.keyFile` and the same key returns the same byline.
- **The key is saved before anything is sent,** so it's never lost.
- **The SDK solves the relayer's proof-of-work for you** (about 1–3 seconds of CPU). Without the SDK, follow `/llms-full.txt` §3A (https://www.by-line.xyz/llms-full.txt).
- **If the relayer answers "Sponsored onboarding is full",** use Path B.

## Path B: register from a funded account (a human's wallet, or an agent given one)

The registry still generates the code. The caller pays about 0.01 NEAR of storage, and the excess is refunded.

**From the user's own keychain (they sign):**

```bash
near contract call-function as-transaction byline.testnet register \
  json-args '{"title":"Acme DCA bot"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as <builder>.testnet network-config testnet sign-with-keychain send
```

Use `sign-with-legacy-keychain` if their key is in `~/.near-credentials`. The transaction's return value contains the new `code`.

**From an agent holding a funded account (SDK):**

```ts
import { Registry } from "@by-line/sdk";
import { nearFromCredentials } from "@by-line/sdk/node";
const registry = new Registry({ network: "testnet", near: nearFromCredentials("funded-agent.testnet", "testnet") });
const { code } = await registry.register({ title: "Acme DCA bot", payout: "acme-team.near" });
```

**Then give the agent its own account (optional):**
1. Generate a key on disk with `generateAgentKey("<code>.byline.testnet", "testnet")`.
2. Call `registry.createAccount(code, publicKey)` (0.05 NEAR).

**To link an account the agent already uses:**
1. The builder calls `registry.inviteAccount(code, accountId)`.
2. The agent then calls `await byline.link()`.

## Use the byline in the agent

```ts
import { Byline } from "@by-line/sdk";
import { jsonlRecorder, nearFromCredentials } from "@by-line/sdk/node";

const byline = new Byline({
  code: agent.code,
  network: "testnet",
  near: nearFromCredentials(agent.accountId, "testnet"),
  accountId: agent.accountId,
  recorder: jsonlRecorder("data/byline-events.jsonl"),   // lets the indexer count it
});

// Swaps: credited quote (dry). 1Click is mainnet-only, so on testnet pass a mainnet recipient.
const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "1", recipient: "<mainnet account>", refundTo: "<mainnet account>" });
q.request.referral;   // the code
q.builderFeeBps;      // the builder's real share after 1Click's split

// Payments: NEP-141 transfer with memo "byline:<code>", signed by the agent's own account.
await byline.transfer({ token: "wrap.testnet", receiverId: "shop.testnet", amountRaw: "1000000000000000000000" });

// Your own 1Click requests: add the byline to them.
const request = await byline.attach(myQuoteRequest);
```

- **A sponsored account starts with 0.03 NEAR.** The SDK uses lean gas so it can keep acting.
- **The human can top it up any time** by sending NEAR to `<code>.byline.testnet`.

## Check it worked

- `await registry.getByline(code)` shows the owner, payout, fee, account, `sponsored` and the title.
- `await registry.getBylineForKey(publicKey)` returns the code, for Path A.
- `await registry.getBylineForAccount(accountId)` returns the code.
- A dry quote echoes `quoteRequest.referral === code`.
- A payment's memo on the explorer reads `byline:<code>`.

## Common errors

| Error | Cause | Fix |
| --- | --- | --- |
| `Sponsored onboarding is full` | The free quota (20 agents at launch) is used up | Use Path B from a funded account |
| `This key already has a byline` | The key onboarded before | `createAgentByline` with the same `keyFile` returns it |
| `doesn't exist on NEAR mainnet ... fee not attached` | The payout is a `.testnet` account or doesn't exist | The builder calls `update` with a mainnet payout; the referral still works |
| `Live swaps settle on NEAR mainnet` | `swap({ live: true })` on testnet | Use a dry quote on testnet |
| `Bylines are non-transferable` | `nft_transfer` was called | Bylines never move; change the payout with `update` |
| `This account was not invited by the byline's builder` | `link_account` before an invite | The builder calls `invite_account` first |
