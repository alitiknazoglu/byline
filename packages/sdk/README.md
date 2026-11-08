# @bylinecode/sdk

Give your AI agent a byline on NEAR. Every swap, payment and transaction it makes is credited to the agent and to its builder, and swaps through NEAR Intents pay the builder a share of the fee.

```bash
npm install @bylinecode/sdk
```

## Get a byline

An agent with nothing but a key onboards itself; no NEAR is needed. The registry generates the code and pays for the agent's own account:

```ts
import { createAgentByline } from "@bylinecode/sdk/node";

const agent = await createAgentByline({ network: "mainnet", title: "Acme DCA bot", payout: "acme-team.near" });
agent.code;       // "k7m2x9qa", the byline every action carries
agent.accountId;  // "k7m2x9qa.byline.near", funded by the registry and controlled only by this key
agent.keyFile;    // ~/.near-credentials/mainnet/k7m2x9qa.byline.near.json (mode 600)
```

- **In a browser,** `createByline({ network, keyPair })` does the same without touching the disk.
- **From a funded wallet** (a human, or an agent given one), use `new Registry({ network, near }).register({ title })`. It returns the code.

## Quick start

```ts
import { Byline } from "@bylinecode/sdk";
import { nearFromCredentials } from "@bylinecode/sdk/node";

const byline = new Byline({ code: agent.code, network: "mainnet", near: nearFromCredentials(agent.accountId, "mainnet"), accountId: agent.accountId });

// Dry by default: nothing moves.
const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "10" });
q.request.referral;  // "k7m2x9qa"
q.request.appFees;   // [{ recipient: <payout>, fee: 40 }]
q.builderFeeBps;     // what the builder actually earns after 1Click's split, e.g. 20

// Live swap (mainnet): commits the quote, deposits with memo "byline:k7m2x9qa", notifies 1Click.
const s = await byline.swap({ from: "USDC", to: "wNEAR", amount: "10" }, { live: true });
await byline.oneClick.waitForStatus(s.depositAddress!);

// Token payment credited to the byline (testnet or mainnet).
await byline.transfer({ token: "usdc.near", receiverId: "shop.near", amountRaw: "2500000", note: "order-17" });
```

Already building your own 1Click requests? Add the byline to any of them:

```ts
const request = await byline.attach(myQuoteRequest); // adds referral + appFees
```

## What it guarantees

- **Dry by default.** `quote()` and `swap()` only preview unless you pass `{ live: true }`. Live swaps refuse to run on testnet.
- **Fees only go to real payouts.** 1Click accepts any account name as a fee recipient, so a fee sent to a missing account is lost, or claimable by whoever registers that name later. The SDK checks the payout on NEAR mainnet first. If it can't receive fees, the SDK drops the fee, keeps the referral, and says why in `attribution.warnings`.
- **One byline per quote.** `withByline` refuses a request that already carries a different referral.
- **Recording never breaks the agent.** The optional `recorder` gets every quote, deposit, transfer and status. If it throws, the SDK ignores the error.

## Accounts

- **The agent's own account** `<code>.byline.near` is created by the registry, either during gasless onboarding or with `registry.createAccount` for wallet-registered bylines. Every transaction it signs counts for the byline. If you don't pass `accountId`, the SDK uses this account.
- **Sponsored accounts start with 0.03 NEAR,** so the SDK attaches lean gas: 10 Tgas for registry calls, 25 Tgas for a storage registration plus a transfer. That's because a function call reserves its prepaid gas at a pessimistic price until it settles.
- **An existing account** must be linked with two calls: the builder calls `registry.inviteAccount(code, accountId)`, then the agent calls `byline.link()`.

## Node helpers

```ts
import { jsonlRecorder, nearFromCredentials } from "@bylinecode/sdk/node";

const near = nearFromCredentials("nw5s2ea1.byline.testnet", "testnet"); // ~/.near-credentials, keys stay on disk
const byline = new Byline({ code: "nw5s2ea1", network: "testnet", near, recorder: jsonlRecorder("data/events.jsonl") });
```

## API

| Export | What |
| --- | --- |
| `createByline`, `createAgentByline` (node) | Gasless onboarding: sign a register message, the relayer submits it, the registry pays |
| `Byline` | One agent: `attribution()`, `attach()`, `quote()`, `swap()`, `status()`, `transfer()`, `link()` |
| `Registry` | The registry contract. Views: `getByline`, `getBylines`, `getBylinesForOwner`, `getBylineForAccount`, `getBylineForKey`, `getAttribution`, `getSponsorStatus`. Calls: `register`, `update`, `createAccount`, `inviteAccount`, `linkAccount`, `unlinkAccount`, `registerSigned` (relayer) |
| `Relayer` (`@bylinecode/sdk/relay`) | The relayer behind gasless onboarding: verifies, rate-limits and submits with a function-call key on the registry |
| `OneClick` | Minimal 1Click client: `tokens`, `token`, `quote`, `submitDeposit`, `status`, `waitForStatus` |
| `withByline`, `resolveAttribution`, `mainnetPayoutChecker`, `builderShare` | The attribution building blocks |
| `isValidCode`, `codeForKey`, `bylineMemo`, `parseBylineMemo`, `agentAccountId` | Code and memo rules, the same ones the contract enforces |

## Tests

```bash
npm test -w @bylinecode/sdk                     # unit tests, no network
npm run test:live -w @bylinecode/sdk            # live reads: byline.testnet, 1Click dry quotes, mainnet RPC
LIVE_WRITE=1 npm run test:live -w @bylinecode/sdk  # also sends 0.001 wNEAR on testnet with the memo (needs the demo agent's key)
```
