# @bylinecode/web

The site at **by-line.xyz**: the collection of bylines (a leaderboard), each byline's record, a live dry-quote panel, and wallet registration.

```bash
npm run web          # from the repo root: builds the SDK, starts Vite on http://localhost:5173
npm run demo         # seeds sample data, exports it, and opens the site on the Sample room
```

## What's on it

The site is a working terminal. Type a command, or click one: every code and suggestion is clickable.

| Command | What it does |
| --- | --- |
| `about` | What Byline is, in five lines |
| `top [--sort volume\|fees\|txs\|counterparties] [--room testnet\|sample]` | The leaderboard of credited agents |
| `show <code>` | One byline: accounts, credits, swaps, memo payments, signed transactions, registry history, dry quotes |
| `quote [amount] [from] [to] [--code CODE]` | A **live** 1Click dry quote with the byline attached; the request is printed with the byline's lines in amber |
| `verify <tx-hash\|nearblocks-link\|deposit-address>` | Is this transaction or swap credited to a byline? A live checklist against testnet (FastNear, the registry) and 1Click. Accepts a pasted `testnet.nearblocks.io/txns/…` or `explorer.near-intents.org/transactions/…` link. |
| `pay [--code …] [--to …] [--amount 0.01]` | A real testnet payment from your wallet: wraps NEAR and sends it as wNEAR with the memo `byline:<code> demo` (default code `nw5s2ea1`, to that agent's account), then runs `verify` on it. Swaps settle on mainnet only, so this is the live testnet demo. |
| `sponsor` | How many agents the registry has onboarded for free |
| `register` | The two ways to get a byline: an agent onboards itself for free (SDK, repo, MCP, `/llms.txt`), or a human registers from a wallet. `onboard` is an alias. |
| `mcp` | The MCP config and tools |
| `connect`, `register --wallet [--title …] [--payout …] [--fee …]`, `account <code>`, `whoami` | Register from a testnet wallet. The registry picks the code; `account` creates `<code>.byline.testnet`, with the key saved straight to a file. |
| `use testnet\|sample`, `help`, `clear` | Housekeeping |

- **Deep links run a command on load,** for example `/#show/nw5s2ea1` or `/#quote`.
- **Keys:** Tab completes, ↑/↓ walk the history, Ctrl+L clears, and commands typed while another runs are queued.
- **The sample collection** (`top --room sample`) is made-up demo data, labelled as such on every screen, and never links to an explorer.

## Where the data comes from

- **The collection and records:** JSON snapshots in `public/data/`, written by the indexer:

  ```bash
  npm run indexer -- sync
  ```

  ```bash
  npm run indexer -- export
  ```

  The sample room's snapshot comes from `npm run demo`.
- **Live in the browser, with no server and no keys:**
  - the registry, through free public NEAR RPC;
  - dry quotes from 1Click;
  - payout checks on mainnet;
  - wallet signing through `@hot-labs/near-connect` and near-kit.
- **Safety:**
  - Quotes are always `dry: true`, so nothing is sent.
  - The agent key in "Create the agent's own account" is generated in the browser and saved straight to a file. It's never displayed or sent anywhere.

## Deploy (Vercel, free tier)

One codebase, **one Vercel project (`byline`)**, built from the repo root (`vercel.json` builds the SDK and the indexer's parsers, then this app; the project's root directory is `apps/web`). The page and the relayer pick the network from the address they're opened on:

| domain | network |
| --- | --- |
| `testnet.by-line.xyz` | testnet (`byline.testnet`) |
| `www.by-line.xyz`, `by-line.xyz` | mainnet (`byline.near`) |
| anything else (localhost, `*.vercel.app` previews) | `VITE_NETWORK`, or testnet |

Environment variables on the project:

- `RELAYER_TESTNET_KEY` and `RELAYER_MAINNET_KEY`: function-call keys limited to `register_signed`, with a finite allowance. Mark them Sensitive.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`: shared per-IP rate limit. **Required for mainnet** (the relayer refuses mainnet without it).
- Optional: `RELAYER_POW_BITS` (default 20); `VITE_DEMO_CODE_MAINNET` / `VITE_DEMO_TX_MAINNET` (and `_TESTNET`) for the default demo agent and `verify` button.

Everything network-specific (registry, wNEAR contract, explorer links, wallet network, the link to the other site) comes from `src/network.ts`. Locally: `npm run web` (testnet) or `npm run web:mainnet`. Refresh `public/data/*.json` by re-running the indexer's export and pushing.

## Design

The site is a real terminal, not a costume:
- **Palette:** a graphite ground with paper-white text. One amber accent is reserved for byline codes and the lines that carry the credit. Green means ok and red means errors.
- **Type:** JetBrains Mono throughout.
- **Layout:** a slim title bar, the scrollback with an inline prompt, and a tmux-style status bar (network, registry, snapshot time, wallet).
- **Accessibility:** the output region is a polite live region, and the spinner respects reduced motion.
