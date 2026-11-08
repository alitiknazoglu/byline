# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript, built as a static single-page app and hosted on Vercel's free tier at by-line.xyz. The user asked for the most cost-efficient setup. There's no server: the browser reads the registry over free public NEAR RPC (FastNear) and asks 1Click for dry quotes, and the indexer's numbers ship as a JSON snapshot.

## Users

- **First-time evaluators (primary for the first screen).** Developers, NEAR ecosystem teams and counterparties sizing up Byline in a few minutes, often following the README's "do X → see Y" steps. Some are AI agents such as Claude Code or Codex. They need proof that the mechanism is real: agents credited on a leaderboard, and a live 1Click quote with the byline inside it.
- **AI-agent builders.** They want their agent to have an identity on NEAR, to have its swaps, payments and transactions credited, and to earn a share of swap fees. Their job is to register a byline, get `<name>.byline.near`, and wire the SDK into the agent.

## Product Purpose

Byline gives an AI agent an on-chain identity on NEAR (a "byline"), so that every action the agent takes is credited to it and to whoever built it. Success means a builder can register a byline in a minute, see their agent's real activity counted, and see the fee share arriving from NEAR Intents swaps.

## Positioning

- The identity is enforced by the protocol: only the registry can create `<name>.byline.near`, so every transaction from that account provably belongs to that agent.
- One byline is credited across every channel: NEAR Intents (1Click) swaps through `referral` + `appFees`, NEP-141 payments through the memo `byline:<name>`, and every transaction the agent's accounts sign.
- Bylines are non-transferable. They're a permanent identity for measuring contribution and aren't for sale.

## Operating Context

- **Networks:** the registry is `byline.testnet` (live now) and `byline.near` on mainnet (later; the human signs). 1Click swaps settle on NEAR mainnet only, so testnet shows dry quotes and real transactions and memo payments, but no real swaps.
- **Data:**
  - The indexer (apps/indexer) writes SQLite and exports JSON snapshots for the site.
  - Sample data for the no-keys demo is labelled sample and is never linked to explorers.
- **Wallets:** wallet connect through `@hot-labs/near-connect`, with signing through near-kit's adapter.
- **Explorers:** testnet.nearblocks.io and nearblocks.io for transactions, and the Intents Explorer for swaps.

## Capabilities and Constraints

- **Leaderboard metrics:**
  - successful swaps, with refunded and failed swaps shown separately;
  - volume in USD (SUCCESS only);
  - estimated builder fees (1Click's real split, about 20 bps for a 40 bps request);
  - signed transactions, unique counterparties, memo payments, and accounts.
- **Byline page:**
  - owner, payout, fee and accounts;
  - swaps, transactions, memo payments, registry events, dry quotes, and the payout's intents.near balances.
- **Try it:** a live **dry** 1Click quote for any byline, showing the raw request with `referral` and `appFees`, the builder's real share, and the SDK's warnings (for example, a payout that doesn't exist on mainnet means no fee is attached).
- **Register** (wallet-signed, testnet first):
  - `register(name, payout?, fee_bps?, title?, description?)` with a 0.01 NEAR deposit, of which the excess is refunded;
  - `create_account(name, public_key)`;
  - `invite_account` / `link_account`.
- **Names:** 2–32 characters of `a-z0-9`, joined by single `-` or `_`; the names byline, admin, root, system, www, api and app are reserved.
- **Fees:** `fee_bps` is 0–100, default 40.
- **Safety:** quotes are dry by default, and the human signs every mainnet transaction. The site never asks for a seed phrase or private key.
- **Wording:** use Byline's own vocabulary (byline, credit, builder, payout). Never name or compare against other ecosystems' attribution programs in the product or repo.

## Brand Commitments

- Name: **Byline**. Line: **"Every agent action, credited."** Domain: **by-line.xyz**. Account names: `byline.near` / `byline.testnet`. Memo prefix: `byline:`.
- No logo, colors or fonts exist yet; design from scratch.

## Evidence on Hand

- **Real testnet data:**
  - byline `demo-agent`, with the account `demo-agent.byline.testnet`;
  - 2 signed transactions, including a memo payment (tx DqEHzQZ92Fo25vWWZNmLpbnrweu5U2pRcn6xtPPEnCMV);
  - registry events, and a refused transfer (tx 8J3PyP1m7gTN3a3iYUipTqp4rZCACvHviQe1BPDQFsA3).
- **Real recorded 1Click quotes** are in `fixtures/quote-*.json`. A measured fee split: a 10 bps request returned 5 bps to the payout plus 20 bps to 1Click.
- **Sample data:** 3 bylines (acme-trader, yield-scout, pay-bot) and 5 accounts, made up and labelled sample.
- **Absent:** there are no real mainnet swaps, users, testimonials, partners or usage numbers yet. Never imply any.

## Product Principles

1. **Proof over claims.** Every number links to where it came from: a transaction, a quote, or a registry view. Sample data always says it is sample data.
2. **Honest metrics.** Volume is gameable, so it always sits next to fees paid and unique counterparties, and refunds and failures are never folded into success.
3. **Safe by default.** Quotes are dry unless stated, testnet comes first, and the user signs every transaction.
4. **One identity, every channel.** Swaps, payments and transactions are credited to the same byline.
5. **A first-visit path that's under a minute.** The first screen has to show the mechanism working.

## Accessibility & Inclusion

WCAG 2.2 AA as the baseline: keyboard reachable, visible focus, sufficient contrast in both themes, and reduced motion respected. No product-specific need has been established beyond that.
