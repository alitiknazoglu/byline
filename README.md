# Byline

**Every agent action, credited.** · [www.by-line.xyz](https://www.by-line.xyz) (mainnet) · [testnet.by-line.xyz](https://testnet.by-line.xyz) (testnet)

**Mainnet registry:** [`byline.near`](https://nearblocks.io/address/byline.near?tab=contract), source verified on NearBlocks / SourceScan (reproducible build of commit [`8980182`](https://github.com/alitiknazoglu/byline/tree/8980182066d193d479ea54fea3a2a36fd7cb4b01), code hash `45vaJt8P6cLCqw7SeEBshxuhz7qLwZaLsCQ6LSJN7Eha`). Testnet registry: `byline.testnet`.

> Work in progress for NEAR HACKATHON 2026 (track: Agent Economy).

**Your AI agent gets an identity on NEAR.** The registry gives it a **byline**: a random code like `k7m2x9qa`, plus its own account `k7m2x9qa.byline.near` that only the registry can create. The agent attaches the code to everything it does:
- every swap through NEAR Intents carries it as the referral and pays the builder a share of the fee;
- every token payment carries `byline:k7m2x9qa` in its memo;
- every transaction its account signs is counted.

**An agent with nothing but a key onboards itself for free:** it signs one message, and the registry pays for its byline and its funded account.

## Try it in two minutes (no keys, no funds)

```bash
npm ci
npm run demo
```

1. **`npm run demo`** builds everything, then:
   - loads the **sample** room (made-up agents, clearly labelled);
   - runs the repo's demo agent **`nw5s2ea1`** for **3 dry rounds**, each a real 1Click quote credited to its code;
   - indexes the live testnet registry;
   - opens the site at http://localhost:5173.

   Expect `referral "nw5s2ea1"` on every round in the terminal.
2. **The site is a terminal.** It boots with `about` and the live leaderboard (`top`). Click **`$ quote`**: a live 1Click quote comes back with `"referral": "nw5s2ea1"` printed first in amber. Nothing is sent.
3. **Click the code `nw5s2ea1`** (or type `show nw5s2ea1`). Expect:
   - the new **dry quotes**;
   - a real **memo payment** (`byline:nw5s2ea1 dca-fee`) and the **transactions its own account signed**, each linking to testnet NearBlocks;
   - registry history showing the agent **onboarded itself with a signed message** while the registry paid.

   `verify Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h` checks that payment live.
4. **Type `top --room sample`** to see what a busy collection looks like: credited and refunded swaps, builder fees, payments. All of it is labelled sample.
5. **Onboard your own agent from nothing (testnet):**

   ```bash
   npm run relayer                       # needs RELAYER_TESTNET_KEY in .env (a function-call key on byline.testnet)
   ```

   ```bash
   BYLINE_RELAYER_URL=http://localhost:8787/register npm run agent -- --create --pay
   ```

   This creates a new key, gets a code and a funded `<code>.byline.testnet`, runs dry rounds, and sends a real payment from the agent's own account. Then `npm run index` puts it in the collection. Once the hosted relayer is live, `npm run agent -- --create` works without the first command.
6. **Humans can also register from a wallet:** type `connect` then `register` in the site's terminal. The registry generates the code and you pay about 0.01 NEAR of storage.

**Tests:**
- `npm test` runs the unit tests (SDK + indexer).
- `npm run test:live` runs the live tests against testnet and 1Click.
- `npm run mcp:audit` grades the MCP server with mcprobe in a sandboxed environment (currently 82/100, B).
- **Security:** the pre-mainnet review and its fixes are summarised in `contract/RULES.md` §9 and §13 (relayer key allowance, sponsorship limits, deploy-time init, trust model, verified builds).
- `contract/` holds 29 unit tests plus a sandbox test of both registration paths.

## Use it from code

```ts
import { Byline } from "@bylinecode/sdk";
import { createAgentByline, nearFromCredentials } from "@bylinecode/sdk/node";

const agent = await createAgentByline({ network: "testnet", title: "Acme DCA bot" }); // gasless: new key → code + funded account
const byline = new Byline({ code: agent.code, network: "testnet", near: nearFromCredentials(agent.accountId, "testnet"), accountId: agent.accountId });
const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "10", recipient: "near", refundTo: "near" }); // dry by default
q.request.referral; // agent.code
```

See [packages/sdk](packages/sdk/README.md). For agents in an MCP client (Claude Code, Cursor and others), use [packages/mcp](packages/mcp/README.md). To count what agents contributed, see [apps/indexer](apps/indexer/README.md). Coding agents can follow [skill/SKILL.md](skill/SKILL.md) to give an agent a byline end to end.

## How an agent gets its byline

- **On its own, with no funds:** it signs a NEP-413 "register me" message, and the relayer submits it with a function-call key on the registry.
  - The registry verifies the signature on-chain and generates the code.
  - It creates `<code>.byline.near` for the agent's key, funded with 0.03 NEAR.
  - The registry sponsors a limited number of agents (20 at launch, raised by hand). To stop farming, the relayer asks each new registration for a small proof-of-work (about a second of CPU, solved by the SDK) and rate-limits per IP in a shared store.
- **From a funded wallet:** a human, or an agent its human gave a funded wallet, calls `register`. The registry generates the code, and the caller pays about 0.01 NEAR of storage.
- **Credit after that:**
  - **Swaps:** the SDK sets the NEAR Intents `referral` to the code and routes an `appFees` share to the payout.
  - **Payments:** token transfers carry `byline:<code>` in their memo.
  - **Transactions:** everything `<code>.byline.near` (or a linked account) signs counts.

## Layout

| Path | What |
| --- | --- |
| `contract/` | Registry contract (Rust) at `byline.near` / `byline.testnet`: random codes, gasless signed registration with sponsored accounts, account linking, NEP-297 events |
| `packages/sdk/` | TypeScript SDK `@bylinecode/sdk`: gasless onboarding, the relayer, a byline on 1Click swaps, dry-by-default swaps, memo transfers, payout checks |
| `packages/mcp/` | MCP server `byline-mcp`: nine tools so any MCP agent can create its byline, quote, pay, and verify credit (strict inputs, typed outputs, spending tools marked destructive) |
| `apps/indexer/` | Contribution indexer into SQLite: registry, agent transactions and memo payments (FastNear), SDK-recorded swaps + 1Click status, Intents Explorer (with a JWT), `intents.near` fee balances |
| `apps/web/` | www.by-line.xyz and testnet.by-line.xyz (one build and one Vercel project; the address picks the network): a working terminal (`top`, `show`, live `quote` and `verify`, `register` for agents and wallets, `mcp`, and `/llms.txt` for agents) |
| `apps/agent/` | Scripted DCA demo agent on the SDK: onboards itself with `--create`, dry by default, `--pay` for a real memo payment, optional NEAR AI Cloud explanations |
| `skill/` | Coding-agent skill: "give my agent a byline on NEAR" |
| `fixtures/` | Recorded real API responses for the no-keys demo |
| `scripts/` | The local relayer (`npm run relayer`), the NEP-413 fixture generator, spikes |

## License

MIT
