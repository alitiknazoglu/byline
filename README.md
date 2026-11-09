# Byline

**Every agent action, credited.** · [www.by-line.xyz](https://www.by-line.xyz) (mainnet) · [testnet.by-line.xyz](https://testnet.by-line.xyz) (testnet)

**The problem:** AI agents now swap, pay and sign transactions on their own. On-chain, though, you can't tell which agent did what, whether its builder earned anything, or whether that agent can be trusted with your money.

**Byline** gives every agent an identity on NEAR, and credits that identity with everything the agent does:

- **The identity:** the registry contract gives each agent a **byline**. That's a random code like `k7m2x9qa`, held as a non-transferable NFT, plus the agent's own account `k7m2x9qa.byline.near`, which only the registry can create.
- **The credit:** the agent attaches the code to everything it does.
  - Every swap through **NEAR Intents** carries it as the `referral` and pays the builder a fee share.
  - Every token payment carries `byline:k7m2x9qa` in its memo.
  - Every transaction the agent's account signs is counted.
- **The track record:** every credit is public and permanent, so an agent's record grows into its **trust score**. It works like a credit history, except anyone can check it on-chain.
- **Onboarding is free:** an agent with nothing but a key signs one message, and the registry pays for its byline and a funded account.

**Mainnet registry:** [`byline.near`](https://nearblocks.io/address/byline.near?tab=contract).
- Its source is verified on NearBlocks / SourceScan: it's a reproducible build of commit [`8980182`](https://github.com/alitiknazoglu/byline/tree/8980182066d193d479ea54fea3a2a36fd7cb4b01), with code hash `45vaJt8P6cLCqw7SeEBshxuhz7qLwZaLsCQ6LSJN7Eha`.
- The testnet registry is `byline.testnet`.

## NEAR HACKATHON 2026 tracks

Byline is entered in three tracks: Agent Economy (primary), NFTs That Do Something and Unstoppable DeFi.

### 1. Agent Economy (`agents`), primary track

This track covers agents that earn, spend and pay. Byline is the layer that records who did it:

- **Earn:**
  - Every 1Click swap an agent quotes carries its code as `referral`, plus an `appFees` share sent to its builder's payout.
  - Byline reports the share 1Click actually pays, not the one requested.
- **Spend and pay:**
  - Payments are NEP-141 transfers with the memo `byline:<code>`, signed by the agent's own account.
  - The MCP server caps live spending in dollars, per swap and per process, and mainnet payments need an explicit `confirm`.
- **Self-onboarding:** an agent with 0 NEAR signs a NEP-413 message. The registry then creates and funds its account on-chain, with no human involved.
- **Any agent can use it:**
  - the SDK (`@by-line/sdk`);
  - the MCP server (`npx -y @by-line/mcp@0.2.0`, nine tools);
  - `/llms.txt`, a complete manual written for AI agents.

### 2. NFTs That Do Something (`nfts`)

This track asks for "NFTs as accounts". A byline is one:

- **It's an NFT:** a NEP-171 token (with NEP-177 metadata and NEP-181 enumeration). The token id is the code, so any wallet or NFT indexer can list it.
- **It owns an account:** each byline comes with its own account, `<code>.byline.near`. That account holds the agent's key and funds, and only the registry can create it, so whatever it signs is provably the agent's.
- **It earns:** the byline's payout account receives the builder fees from every credited swap.
- **It's a credential:** the byline is soulbound (`nft_transfer` is refused), so its track record can't be bought, sold or moved. Owners, counterparties and other agents read it before trusting the agent.
- **It carries access:** linked accounts and invites (`invite_account` → `link_account`) let one byline cover several of a builder's accounts.

### 3. Unstoppable DeFi (`defi`)

Byline is the attribution layer for trading agents that settle through **NEAR Intents (1Click)**:

- Every quote carries the agent's `referral` and `appFees`.
- Live swaps are exact-input, checked against the request, and capped in dollars.
- Swaps are credited only once 1Click reports `SUCCESS`. Refunded or failed swaps are shown separately and never counted.
- The leaderboard ranks agents by settled volume, builder fees, transactions and unique counterparties.

### What NEAR makes possible here

- **Named sub-accounts:** only `byline.near` can create `<code>.byline.near`, so the protocol itself proves which agent signed a transaction.
- **NEP-413 plus `ed25519_verify`:** a key holding 0 NEAR proves itself off-chain, and the contract verifies it on-chain. That's how gasless onboarding works with no custodian.
- **Function-call access keys:** the relayer's key can call only `register_signed`, and only up to a fixed allowance.
- **NEAR Intents:** cross-chain swaps with `referral` and `appFees` built into the quote, so credit and fees travel with the trade.
- **NEP-297 events:** every registration and update is logged, so anyone can rebuild the full history.

## Try it

### A. In the browser: no install, no keys, no funds

1. **Open [testnet.by-line.xyz](https://testnet.by-line.xyz).** You'll see a terminal that starts with `about` and the live leaderboard (`top`). The data comes straight from `byline.testnet`.
2. **Click `$ quote`.** You'll get a real 1Click quote with `"referral": "nw5s2ea1"` printed first, in amber. It's a dry quote, so nothing is sent.
3. **Type `show nw5s2ea1`** to see the demo agent's page:
   - its dry quotes;
   - a real memo payment (`byline:nw5s2ea1 dca-fee`);
   - the transactions its own account signed, each linking to NearBlocks;
   - registry history showing it **onboarded itself with a signed message** while the registry paid.
4. **Type `verify Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h`.** The terminal checks that payment live and shows ✓ credited to `nw5s2ea1`. You can also paste a NearBlocks link instead of the hash.
5. **Type `top --room sample`** to see what a busy collection looks like: credited and refunded swaps, builder fees and payments. Every row is labelled as sample data.
6. **Open [www.by-line.xyz](https://www.by-line.xyz)** for the same terminal on **mainnet**, reading the verified `byline.near`. The demo agent there is `zertrk6r`.
7. **Read [/docs](https://www.by-line.xyz/docs)** for the model in plain words, or [/llms.txt](https://www.by-line.xyz/llms.txt) for the manual written for AI agents.

### B. From an MCP client (Claude Code, Cursor and others)

Add this to your MCP config:

```json
{ "mcpServers": { "byline": { "command": "npx", "args": ["-y", "@by-line/mcp@0.2.0"], "env": { "BYLINE_NETWORK": "testnet" } } } }
```

Then ask your agent: *"Create my byline, then quote 10 USDC to wNEAR with it."*

- `byline_create` onboards the agent gaslessly. You'll get a new code and a funded `<code>.byline.testnet`, with its key saved locally.
- `byline_quote` returns a dry quote carrying that code.
- `byline_verify <tx-hash>` checks credit for any transaction.

### C. From the repo: the full local demo

```bash
npm ci
npm run demo
```

`npm run demo`:
1. builds everything;
2. loads the sample room;
3. runs the demo agent `nw5s2ea1` for 3 dry rounds, each one a real 1Click quote credited to its code;
4. indexes the live testnet registry;
5. opens the site at http://localhost:5173.

You should see `referral "nw5s2ea1"` on every round in the terminal output.

**Onboard your own agent from nothing (testnet):**

```bash
npm run agent -- --create --pay
```

This command:
- creates a new key;
- asks the hosted relayer for a byline, and solves a short proof-of-work (about a second);
- gets a code and a funded `<code>.byline.testnet`, with the key saved to `~/.near-credentials/testnet/`;
- runs dry rounds;
- sends a real payment from the agent's own account.

After that, `npm run index` adds the new agent to the leaderboard. To run your own relayer instead, use `npm run relayer` (it needs `RELAYER_TESTNET_KEY` in `.env`), then set `BYLINE_RELAYER_URL=http://localhost:8787/register`.

**Register as a human:** in the site's terminal, type `connect`, then `register`. The registry generates the code, and you pay about 0.01 NEAR of storage.

### Tests

- `npm test`: unit tests for the SDK, indexer and MCP server.
- `npm run test:live`: live tests against testnet and 1Click.
- `npm run mcp:audit`: grades the MCP server with mcprobe in a sandbox. It currently scores 88–90/100. Only the liveness score moves, with network latency.
- `contract/`: 29 unit tests, plus a sandbox test of both registration paths (`cargo test`).

### Security

- **Pre-mainnet contract review:** `contract/RULES.md` §9 and §13 cover the relayer key allowance, sponsorship limits, deploy-time init, the trust model and verified builds.
- **Whole-repo review (2026-11-09):** 8 parallel reviewers, with adversarial verification of each finding. Every high and medium finding is fixed, with tests:
  - time budgets on the indexer;
  - relayer replay and rate limits;
  - USD spend caps and confirmation in the MCP server;
  - strict deep links.
- **Mainnet keys:** `byline.near` holds one full-access key, plus one function-call key limited to `register_signed`.

## Use it from code

```ts
import { Byline } from "@by-line/sdk";
import { createAgentByline, nearFromCredentials } from "@by-line/sdk/node";

const agent = await createAgentByline({ network: "testnet", title: "Acme DCA bot" }); // gasless: new key → code + funded account
const byline = new Byline({ code: agent.code, network: "testnet", near: nearFromCredentials(agent.accountId, "testnet"), accountId: agent.accountId });
const q = await byline.quote({ from: "USDC", to: "wNEAR", amount: "10", recipient: "near", refundTo: "near" }); // dry by default
q.request.referral; // agent.code
```

More:
- [packages/sdk](packages/sdk/README.md): the SDK.
- [packages/mcp](packages/mcp/README.md): agents in an MCP client.
- [apps/indexer](apps/indexer/README.md): counting what agents contributed.
- [skill/SKILL.md](skill/SKILL.md): coding agents can follow it to give an agent a byline end to end.

## How an agent gets its byline

### On its own, with no funds

1. The agent signs a NEP-413 "register me" message, and the relayer submits it with a function-call key on the registry.
2. The registry verifies the signature on-chain and generates the code.
3. It creates `<code>.byline.near` for the agent's key, funded with 0.03 NEAR.

**Limits:**
- The registry sponsors a limited number of agents: 20 on mainnet at launch, raised by hand.
- To stop farming, the relayer asks for a small proof-of-work per registration. It takes about a second of CPU, and the SDK solves it.
- The relayer also rate-limits per IP, using a shared store.

### From a funded wallet

A human (or an agent whose human gave it a funded wallet) calls `register`. The registry generates the code, and the caller pays about 0.01 NEAR of storage.

### How credit works after that

- **Swaps:** the SDK sets the NEAR Intents `referral` to the code and routes an `appFees` share to the payout. A swap is credited when 1Click reports it settled.
- **Payments:** token transfers carry `byline:<code>` in their memo.
- **Transactions:** everything `<code>.byline.near` (or a linked account) signs counts.

## Layout

| Path | What |
| --- | --- |
| `contract/` | The registry contract (Rust) at `byline.near` / `byline.testnet`: a soulbound NEP-171 NFT per agent, random codes, gasless signed registration with sponsored accounts, account linking and NEP-297 events |
| `packages/sdk/` | The TypeScript SDK `@by-line/sdk`: gasless onboarding, the relayer, a byline on 1Click swaps, dry-by-default swaps, memo transfers and payout checks |
| `packages/mcp/` | The MCP server `@by-line/mcp`: nine tools so any MCP agent can create its byline, quote, swap, pay and verify credit. Inputs are strict, outputs are typed, and spending tools are marked destructive and capped |
| `apps/indexer/` | The contribution indexer: the registry, agent transactions and memo payments (FastNear), swaps found from on-chain deposits plus 1Click status, and `intents.near` fee balances |
| `apps/web/` | www.by-line.xyz and testnet.by-line.xyz, one build where the address picks the network. It includes: a working terminal (`top`, `show`, live `quote` and `verify`, `register`, `mcp`); a live `/api/snapshot` that indexes the chain on demand; the gasless relayer at `/api/register`; `/docs`; and `/llms.txt` + `/llms-full.txt` for agents |
| `apps/agent/` | A scripted DCA demo agent on the SDK. It onboards itself with `--create`, is dry by default, and sends a real memo payment with `--pay` |
| `skill/` | A coding-agent skill: "give my agent a byline on NEAR" |
| `fixtures/` | Recorded real API responses for the no-keys demo |
| `scripts/` | The local relayer (`npm run relayer`), the NEP-413 fixture generator, and the MCP audit |

## Built with

| Area | Libraries and tools |
| --- | --- |
| Contract | `near-sdk` and `near-contract-standards` 5.30, built reproducibly with `cargo-near` |
| TypeScript | `near-kit`, `@noble/hashes`, `@modelcontextprotocol/sdk`, `zod` |
| Web | React, Vite, `@hot-labs/near-connect` (wallets), JetBrains Mono |
| Services | NEAR Intents 1Click API, FastNear, dRPC (RPC), Upstash Redis (rate limits and cache), Vercel |

All code here was written during NEAR HACKATHON 2026, with AI coding assistance. No pre-hackathon code is reused.

## License

MIT
