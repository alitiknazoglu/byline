# @by-line/agent

A small scripted DCA agent built on `@by-line/sdk`. Each round it:
1. quotes USDC → wNEAR through NEAR Intents (1Click) with its byline attached;
2. decides whether to buy, skipping a round whose price is more than 1% worse than the best so far;
3. records the quote for the indexer.

**Nothing moves by default.**

```bash
npm run agent -- --code nw5s2ea1               # 3 dry rounds as the repo's demo agent on testnet, no keys needed
npm run agent -- --create                      # your own agent: new key, gasless onboarding, code saved to data/agent-testnet.json
npm run agent -- --rounds 5 --amount 2         # more rounds as your agent, bigger quotes (still dry)
npm run agent -- --rounds 1 --pay              # also send one real testnet payment from the agent's own account
npm run index                                  # count it: sync the indexer and refresh the site snapshot
```

## What each round shows

```
round 1/3  1 USDC → 0.2699 wNEAR  (3.7051 USDC/wNEAR)
  decision      would buy
  credited      referral "nw5s2ea1", builder share 0 bps  (dry quote, recorded)
```

- **The byline rides on every quote** as the 1Click `referral`.
- **The builder share is what 1Click actually records for the payout.** A testnet agent's payout is a testnet account, so the SDK attaches no fee, says why, and keeps the referral.

## Flags

| Flag | Default | What |
| --- | --- | --- |
| `--rounds N` | 3 | Rounds to run |
| `--interval S` | 4 | Seconds between rounds |
| `--amount X` | 1 | USDC per round |
| `--create` | off | Onboard gaslessly: generates a key, the relayer submits a signed register message, and the registry pays for the byline and the agent's account. Set `BYLINE_RELAYER_URL` to use a local relayer (`npm run relayer`). |
| `--code CODE` | `data/agent-<network>.json` | Byline to act as |
| `--title TEXT` | Byline demo DCA agent | Label for a new byline |
| `--network NET` | testnet | Registry network |
| `--recipient ID` | near | Mainnet account used in dry quotes (1Click only quotes for existing mainnet accounts) |
| `--pay` | off | One real testnet NEP-141 payment with memo `byline:<code> dca-fee`, signed by the agent's own account. Needs its key in `~/.near-credentials/testnet/` and is skipped without it. |
| `--live --yes` | off | Mainnet only: really swap, capped at 5 USDC per round. Needs the agent's mainnet key. |

## Optional: the agent explains itself

Set `NEARAI_API_KEY` (and optionally `NEARAI_MODEL`) in `.env`, and each round adds a one-sentence explanation from **NEAR AI Cloud**: private inference in a TEE. The agent prints the chat id, so the response signature can be checked at `GET https://cloud-api.near.ai/v1/signature/<chat id>`.
