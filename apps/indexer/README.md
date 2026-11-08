# @by-line/indexer

Counts what each byline's agent contributed and stores it in SQLite: swaps, transactions, memo payments and fees. The web app and the CLI read from it.

```bash
npm run indexer -- sync                        # one pass over every source (testnet by default)
npm run indexer -- watch --every 300           # keep syncing
npm run indexer -- leaderboard                 # rank bylines
npm run indexer -- show nw5s2ea1 --json        # one byline in detail
npm run demo                                   # sample data into data/demo.sqlite, then the leaderboard
```

Flags: `--network testnet|mainnet`, `--db FILE` (default `data/byline-<network>.sqlite`), `--recorded FILE` (default `data/byline-events.jsonl`, written by the SDK's `jsonlRecorder`). Settings come from the repo's `.env`, and none are required.

## Sources

| What | Source | Key needed |
| --- | --- | --- |
| Bylines, payouts, accounts | Registry views (`get_bylines`) | no |
| Registry history (`byline_registered`, `account_linked`, …, `nft_mint`) | NEP-297 logs in the registry's transactions, from FastNear | no |
| Agent transactions | FastNear account history of each byline's own and linked accounts. **Only transactions the account signed count.** A transaction that merely mentions the account doesn't. | no |
| Memo payments | `ft_transfer` / `ft_transfer_call` actions whose `memo` starts with `byline:<code>`, read from the signed actions, with success taken from the token's receipt | no |
| Swaps made with the SDK | The SDK's JSONL log, plus 1Click `/status` for each deposit address. A swap counts only once 1Click reports `SUCCESS`. | no |
| All swaps with `referral=<code>` | Intents Explorer API, throttled to 1 request every 5 s, **mainnet bylines only** | `EXPLORER_JWT` |
| Fee balance | The payout's balances on `intents.near` (`mt_tokens_for_owner` + `mt_batch_balance_of`), where 1Click credits app fees | no |

## Rules the numbers follow

- **Volume counts only `SUCCESS` swaps.** Refunded, failed and incomplete swaps are shown separately. Dry quotes are previews and never count.
- **Builder fees** are estimated as amount in (USD) × the builder's real share. The share comes from 1Click's echoed `appFees` or the Explorer's record, not from the requested `fee_bps`. For example, 40 bps requested pays about 20.
- **SDK records are claims.** A recorded transfer counts only if the chain shows the same signer and a `byline:<code>` memo.
- **Testnet bylines never own swaps.** 1Click settles on mainnet, and a referral is just a string, so only mainnet bylines are matched against swap history.
- **The fee balance is the payout's whole Intents balance.** If the payout holds other funds on `intents.near`, those show up too. Use a dedicated payout account.
- **Volume is gameable**, because an agent can trade with itself. The leaderboard shows unique counterparties and fees next to volume for that reason.
- **Sample data is always labelled.** `seed` writes rows with `source = 'fixture'` and refuses to write into a database that already has live data. The sample bylines, accounts and hashes are made up, so the app never links them to an explorer. Prices come from a real recorded 1Click quote.

## Tests

```bash
npm test -w @by-line/indexer          # parsers on real saved testnet transactions, sync jobs on fakes, seed
npm run test:live -w @by-line/indexer # full read-only sync of byline.testnet into a temporary database
```
