# Byline registry contract

The Rust contract behind Byline, deployed at `byline.testnet` (and at `byline.near` on mainnet later). The rules it enforces are in [RULES.md](RULES.md).

- **A byline is a non-transferable NEP-171 NFT** whose token id is a **random code the registry generates**, such as `k7m2x9qa`. Agents attach the code to every swap (the 1Click referral), every payment (`byline:<code>` memo), and every transaction of their own account.
- **Agents with only a key onboard themselves.** `register_signed` verifies an ed25519 NEP-413 signature on-chain, then mints the byline to `<code>.<registry>` and creates that account for the agent's key, funded with 0.03 NEAR. The registry pays, up to `sponsor_limit` agents (20 by default, raised by hand).
- **Humans, or agents with a funded wallet, call `register`.** The registry picks the code and the caller pays about 0.01 NEAR of storage, refunded above cost.
- **Only the registry can create `<code>.<registry>`,** so that account's activity provably belongs to the byline.
- **Linking an existing account takes both sides,** and payouts can be redirected with `update`.

## Build and test

```bash
cargo near build non-reproducible-wasm   # → target/near/byline_registry.wasm
cargo test --lib                          # 29 unit tests (incl. near-kit-signed NEP-413 fixtures)
cargo test --test test_basics             # sandbox: both registration paths on a real local node
```

## Main methods

| Method | Who | Deposit |
| --- | --- | --- |
| `new(owner_id)` | deployer, once | none |
| `register(payout?, fee_bps?, title?, description?)` | any funded account | storage; the excess is refunded |
| `register_signed(public_key, message, nonce, signature)` | the registry's relayer key only | none; the registry pays |
| `update(code, payout?, fee_bps?, title?, description?)` | builder | ≥ 1 yoctoNEAR |
| `create_account(code, public_key)` | builder | ≥ 0.01 NEAR; the new account gets it minus 0.002 |
| `invite_account(code, account_id)` / `link_account(code)` / `unlink_account(account_id)` | builder / invited account / either | storage |
| `set_sponsor_limit(limit)` | registry owner | none |
| `nft_transfer` / `nft_transfer_call` | nobody: always refused | n/a |

**Views:**
- `get_byline`, `get_bylines`, `get_bylines_for_owner`;
- `get_byline_for_account`, `get_byline_for_key`;
- `get_attribution`, `get_sponsor_status`;
- the standard `nft_*` views.
