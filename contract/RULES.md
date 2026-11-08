# Byline registry: rules (v2)

The registry contract lives at `byline.near` (mainnet) and `byline.testnet` (testnet). This file states what the contract guarantees, and the code must match it.

## 1. What a byline is

- A **byline** is the on-chain identity of one AI agent: a **non-transferable** NEP-171 NFT whose `token_id` is a random **code** the registry generates, such as `k7m2x9qa`.
- Whoever holds the NFT is the agent's **builder**. For an agent that onboarded itself, that's its own account.
- **Agents attach the code to everything they do:**
  - swaps through 1Click carry it as the `referral`, plus an `appFees` share for the payout;
  - token transfers carry the memo `byline:<code>`;
  - every transaction signed by the agent's own account `<code>.<registry>` (or a linked account) counts too.
- Each byline stores:
  - `payout`, which receives the fee share;
  - `fee_bps`, from 0 to 100, default 40;
  - `account` and `linked` accounts;
  - `sponsored`;
  - `title` and `description`, the human-readable label.

## 2. Codes

- **The registry generates every code; nobody chooses one.** A code is 8 characters from `0123456789abcdefghjkmnpqrstvwxyz`, lowercase base32 without i, l, o or u. It's valid as a NEAR account label and as a 1Click referral.
- **A code is the first 8 base32 characters of `sha256(seed)`:**
  - for a wallet registration, `seed = "byline:v2:<owner>:<n>"`, where `n` counts that owner's registrations, so one wallet can register many agents;
  - for a gasless registration, `seed = "byline:v2:" + <ed25519 public key bytes>`, so a key maps to the same code unless someone already holds it;
  - if the code is taken, the registry derives a fallback from the seed **plus the block's random seed** and `#1`, `#2` and so on, so nobody can pre-register fallbacks to lock a key or wallet out.
- **A code predicted from a key is a hint, not a guarantee.** Before sending funds to `<code>.<registry>`, confirm it with `get_byline_for_key`.
- Codes are never reused while the NFT exists.

## 3. Registering from a funded account: `register(payout?, fee_bps?, title?, description?)`

- This path is for a human's wallet, or an agent that holds a funded account. It's payable.
- It mints a byline with a fresh code to the caller and returns it.
- The caller pays the storage it uses and the excess is refunded in the same call. Too little deposit means a panic and no change.
- `payout` defaults to the caller.

## 4. Gasless registration for an agent that only has a key: `register_signed(public_key, message, nonce, signature)`

- **The agent signs a NEP-413 message.**
  - It contains the tag 2³¹+413, the `message`, a 32-byte `nonce`, `recipient` set to this contract, and no callback URL.
  - The payload is borsh-encoded, sha256-hashed and signed with the agent's ed25519 key.
  - `message` is JSON: `{"action":"register","expires_at_ms":…, "payout"?, "fee_bps"?, "title"?, "description"?}`. Any other field is rejected.
- **Only the registry's own relayer key can submit it.** That key is a function-call key on the registry account limited to `register_signed`, and the relayer rate-limits before it pays gas.
- **The registry checks, in order:**
  1. the signature, on-chain (`env::ed25519_verify`);
  2. `action == "register"`;
  3. that the message hasn't expired and doesn't live longer than 1 hour;
  4. that **this key has no sponsored byline yet**;
  5. that `sponsored_count < sponsor_limit` (default 20);
  6. that the registry can still pay for it.
- **Then it:**
  - derives the code from the key;
  - mints the byline to **`<code>.<registry>`**;
  - creates that account with the agent's key as its only full-access key;
  - funds it with **0.03 NEAR** (`SPONSOR_SEED`) from the registry's balance.
- **The agent then owns its byline through its own account,** so it can `update`, `invite_account` and use the byline with ordinary transactions.
- **If the account can't be created,** the callback removes the byline (`nft_burn` + `byline_revoked`), frees the key and the sponsor slot, and the seed returns to the registry.
- **Replaying a signed message changes nothing:** the key already has its byline.
- **The 0.03 NEAR seed:** a function call reserves its prepaid gas at a pessimistic price (about 0.0066 NEAR per 10 Tgas) until it settles. The seed covers the account's own storage plus that reservation for the small calls the SDK makes: 10 Tgas for registry calls, 25 Tgas for a storage registration plus a transfer.

## 5. The agent's own account for a wallet-registered byline: `create_account(code, public_key)`

- This is payable and builder only. It creates `<code>.<registry>` with `public_key` as a full-access key, funded by the deposit minus 0.002 NEAR.
- **Only the registry can create accounts under its own name,** so `<code>.byline.near` always belongs to byline `<code>`.
- Each byline gets at most one account. On failure the callback refunds the builder.
- The registry only accepts the call while it holds at least the deposit again of its own (plus a 0.01 NEAR margin), so that refund can always be paid before the failed transfer's money is back.

## 6. Linking existing accounts

- Both sides must agree:
  1. the builder calls `invite_account(code, account_id)`;
  2. the account calls `link_account(code)` itself.
- One account belongs to at most one byline. To move, unlink first. There are at most 20 linked or invited accounts per byline. An account that is already linked can't be invited.
- **Registry-created accounts (`*.<registry>`) can't link to another byline.** They belong to their own byline, which the registry links itself.
- `cancel_invite(code, account_id)`: the builder withdraws an unaccepted invite, with exactly 1 yoctoNEAR. The invite's storage goes back to the builder.
- `unlink_account(account_id)` can be called by the account or the builder, with exactly 1 yoctoNEAR (a full-access key). The freed storage goes back to the unlinked account, which paid for it. The byline's own account can't be unlinked.

## 7. Updating: `update(code, payout?, fee_bps?, title?, description?)`

- Builder only, with **at least 1 yoctoNEAR** attached, which forces a full-access key.
- `fee_bps` above 100 is rejected.
- Whether the payout account exists isn't checked on-chain. The SDK checks it on mainnet before attaching fees.

## 8. Bylines are non-transferable

- `nft_transfer` and `nft_transfer_call` always fail, and there are no approvals. The read-only NFT views keep working.
- **To send fees somewhere else,** the builder calls `update` with a new payout.
- **Accepted limit:** if the owner's key is lost, the byline can't be updated anymore.

## 9. Sponsoring

- `get_sponsor_status()` returns `{used, limit, seed}`. The limit starts at 20 and is raised by hand.
- `set_sponsor_limit(limit)` is for the registry owner only, with exactly 1 yoctoNEAR (a full-access key).
- **Each sponsored account is a real gift:** its key holder controls the 0.03 NEAR seed and could delete the account to keep it. That's why the quota is small, the relayer asks for proof-of-work and rate-limits per IP, and the limit is raised gradually.
- **Solvency:** the registry only sponsors while its free balance covers the seed plus a 0.01 NEAR margin, so the callback's own writes always fit.
- **The relayer key:** a function-call key limited to `register_signed` **with a finite allowance**. Every call it makes burns gas from the registry account, including rejected ones, so the allowance (not the quota) is what bounds a leaked key's damage. Keep only a small float on the registry account and rotate the key when the allowance is spent.

## 10. Attribution (what indexers and the SDK read)

- **`get_attribution(code)`** returns `{ referral: code, app_fees: [{ recipient: payout, fee: fee_bps }] }`. `app_fees` is empty when there's no payout or the fee is 0.
- **`get_byline_for_account(account_id)`** gives the code for any linked or own account.
- **`get_byline_for_key(public_key)`** gives the code a key onboarded with.
- **Memos:** token transfers carrying `memo: "byline:<code>"` are credited to `<code>`. Indexers apply this; the contract doesn't. A memo (like a referral) is a claim anyone can attach, so the Byline indexer counts payments **made** by the byline's own accounts separately from the distinct accounts that **paid** it.

## 11. Events (NEP-297, `standard: "byline"`, `version: "2.0.0"`)

- **Byline events:**
  - `byline_registered`, with `via` set to `"tx"` or `"signed"`;
  - `byline_updated` and `byline_revoked`;
  - `account_created`, `account_creation_failed`, `account_invited`, `invite_cancelled`, `account_linked` and `account_unlinked`;
  - `sponsor_limit_set`.
- **Standard NFT events:** minting emits `nep171` `nft_mint`, and a rollback emits `nft_burn`.

## 12. Out of scope (for now)

- Renaming, burning by the builder, recovery accounts and upgrade governance.

## 13. Deployment and trust

- **Initialise in the deploy transaction.** `new(owner_id)` is private (only the registry account can call it), and the deploy and the `new` call go in one batch, so nobody can front-run the init.
- **Whoever holds the registry account's full-access key can redeploy the contract,** and so change anything. Today that is the Byline team. Later the account should be locked (full-access key removed) or moved to a multisig.
- **There is no reset.** The v1 → v2 move on testnet used a one-off `reset` that has since been removed from the code.
- **Verified source:** mainnet builds use `cargo near build reproducible-wasm` (NEP-330 metadata, pinned SourceScan image), so NearBlocks can rebuild and verify the deployed code.

## 14. Known issues for the next deploy (security review, 2026-11-09)

None of these lets anyone take the registry's balance, move a byline or link an account without its consent. They're recorded here because fixing them needs a redeploy of the verified build, which the owner signs.

- **Shared solvency margin (Low).** `register_signed` checks `free_balance >= SPONSOR_SEED + SOLVENCY_MARGIN` once, but each success callback then writes about 100 more bytes (`account_index` and `record.account`). Ten or more registrations in flight at once could share and exhaust the 0.01 NEAR margin; a callback that fails then leaves the byline `account_pending` forever with no repair path.
  - *Mitigated off-chain now:* the relayer is the only caller of `register_signed`, and it submits one registration at a time across every instance (a shared lock in Upstash, released after the transaction is final).
  - *Next deploy:* write `record.account` and `account_index` in `register_signed` itself so the success callback adds no storage, and the failure path removes them.
- **Account names can be re-registered (Low).** Owners, payouts, invites and links are tied to account names. If a linked account or a builder's wallet is deleted and someone re-creates the name, the new holder inherits the link or the ownership. An invite to a name that doesn't exist yet can be front-run by whoever creates it. Builders can unlink or cancel invites; tools should warn before inviting an account that doesn't exist.
- **Unlink refunds the builder's storage to the account (Info).** About 0.0003 NEAR per unlink goes to the unlinked account instead of the builder. The registry's own balance nets to zero.
- **No migration path (Info).** `Contract` and `Record` aren't versioned and there's no `migrate`. Before the first schema change, make `Record` a versioned enum and add a `#[private] #[init(ignore_state)] migrate`.
- **Stale key lookup and predictable codes (Info).** `get_byline_for_key` keeps answering for a key the agent has since rotated away. A victim's code can be predicted with about 2^40 hashes and squatted through `register` + `create_account`; the randomised fallback prevents lockout, and clients must read the code from `get_byline_for_key` after registering, never fund a predicted account (the SDK does this).
