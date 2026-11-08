//! Byline registry: on-chain identity for AI agents on NEAR.
//!
//! A byline is a non-transferable NEP-171 NFT whose token id is a random **code** the registry
//! generates (e.g. `k7m2x9qa`). Agents attach it to everything they do: the 1Click referral and
//! app fee, the `byline:<code>` memo, and the transactions of the agent's own account
//! `<code>.<registry>`. See `RULES.md` for the guarantees this code implements.
//!
//! Two ways to get a byline:
//! - `register`: a funded account (a human's wallet, or an agent holding one) pays its own storage.
//! - `register_signed`: an agent with nothing but a fresh key signs a NEP-413 message; the registry
//!   verifies it on-chain, creates and funds `<code>.<registry>` for that key, and pays for it
//!   (sponsored, up to `sponsor_limit` agents).

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, CurveType, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PublicKey,
};

const NON_TRANSFERABLE: &str = "Bylines are non-transferable: they are a permanent identity. To route fees elsewhere, call update with a new payout.";

/// Fee (basis points) the SDK requests from 1Click when the builder sets none.
pub const DEFAULT_FEE_BPS: u16 = 40;
/// Highest fee a byline may request.
pub const MAX_FEE_BPS: u16 = 100;
/// Linked plus invited accounts per byline.
pub const MAX_LINKED: usize = 20;
/// Minimum deposit for `create_account`: funds the new account and covers registry storage.
pub const MIN_ACCOUNT_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Kept by the registry from the `create_account` deposit for its own bookkeeping storage.
pub const ACCOUNT_STORAGE_RESERVE: NearToken = NearToken::from_millinear(2);
/// What a sponsored agent account starts with: its own storage (~0.002 NEAR) plus room for gas.
/// A function call reserves its prepaid gas at a pessimistic price (~0.0066 NEAR per 10 Tgas) and
/// refunds what it doesn't burn, so the agent needs that much free balance for each call it sends.
pub const SPONSOR_SEED: NearToken = NearToken::from_millinear(30);
/// Sponsored agents allowed until the owner raises it.
pub const DEFAULT_SPONSOR_LIMIT: u32 = 20;
/// A signed registration message is valid for at most this long.
pub const MAX_MESSAGE_TTL_MS: u64 = 60 * 60 * 1000;
/// Kept free on top of locked storage when sponsoring, so the callback's own writes always fit.
pub const SOLVENCY_MARGIN: NearToken = NearToken::from_millinear(10);
/// Length of a byline code.
pub const CODE_LEN: usize = 8;
/// Lowercase base32 without i, l, o, u: valid in NEAR account ids and 1Click referrals, hard to misread.
pub const CODE_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// NEP-413 tag: 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;

const GAS_FOR_ACCOUNT_CALLBACK: Gas = Gas::from_tgas(15);
const MAX_TITLE_LEN: usize = 64;
const MAX_DESCRIPTION_LEN: usize = 280;

// Storage prefixes. Byte strings (not an enum) so they never collide with v1's single-byte prefixes.
const P_OWNERS: &[u8] = b"o";
const P_META: &[u8] = b"m";
const P_ENUM: &[u8] = b"e";
const P_RECORDS: &[u8] = b"r";
const P_ACCOUNTS: &[u8] = b"a";
const P_KEYS: &[u8] = b"k";
const P_COUNTS: &[u8] = b"c";

/// Per-byline data kept next to the NFT.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub payout: Option<AccountId>,
    pub fee_bps: u16,
    /// `<code>.<registry>`, once created.
    pub account: Option<AccountId>,
    /// True while the account-creation promise is in flight.
    pub account_pending: bool,
    pub linked: Vec<AccountId>,
    pub invited: Vec<AccountId>,
    pub created_at_ms: u64,
    /// Registered through `register_signed` (the registry paid for it).
    pub sponsored: bool,
}

/// Everything a client needs about one byline.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BylineView {
    pub code: String,
    pub owner: AccountId,
    pub payout: Option<AccountId>,
    pub fee_bps: u16,
    pub account: Option<AccountId>,
    pub account_pending: bool,
    pub linked: Vec<AccountId>,
    pub invited: Vec<AccountId>,
    pub created_at_ms: u64,
    pub sponsored: bool,
    pub title: Option<String>,
    pub description: Option<String>,
}

/// One 1Click `appFees` entry.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AppFee {
    pub recipient: AccountId,
    pub fee: u16,
}

/// What the SDK copies into a 1Click quote request.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attribution {
    pub referral: String,
    pub app_fees: Vec<AppFee>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SponsorStatus {
    pub used: u32,
    pub limit: u32,
    /// What each sponsored agent account starts with, in yoctoNEAR.
    pub seed: U128,
}

/// The JSON an agent signs (NEP-413 `message`) to register itself.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct RegisterMessage {
    pub action: String,
    pub expires_at_ms: u64,
    pub payout: Option<AccountId>,
    pub fee_bps: Option<u16>,
    pub title: Option<String>,
    pub description: Option<String>,
}

/// NEP-413 payload, borsh-serialized after the tag and hashed with sha256 before signing.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    records: LookupMap<TokenId, Record>,
    /// Linked account (including `<code>.<registry>`) -> code.
    account_index: LookupMap<AccountId, TokenId>,
    /// Public key of a sponsored agent -> its code. One sponsored byline per key.
    key_index: LookupMap<String, TokenId>,
    /// How many bylines each account has registered (seeds its next code).
    owner_counts: LookupMap<AccountId, u32>,
    sponsored_count: u32,
    sponsor_limit: u32,
}

// ---------- helpers ----------

/// The first `CODE_LEN` base32 characters of `sha256(seed)`.
pub fn code_from_seed(seed: &[u8]) -> String {
    let h = env::sha256_array(seed);
    // 8 chars x 5 bits = 40 bits = the first 5 bytes, most significant bit first.
    let mut bits: u64 = 0;
    for b in &h[..5] {
        bits = (bits << 8) | *b as u64;
    }
    (0..CODE_LEN)
        .map(|i| CODE_ALPHABET[((bits >> (35 - 5 * i)) & 31) as usize] as char)
        .collect()
}

pub fn is_valid_code(code: &str) -> bool {
    code.len() == CODE_LEN && code.bytes().all(|b| CODE_ALPHABET.contains(&b))
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "byline", "version": "2.0.0", "event": event, "data": [data] })
    ));
}

/// Charge the caller for storage added since `initial_usage`, then refund the rest of the deposit.
fn settle_storage(initial_usage: u64) {
    let used = env::storage_usage().saturating_sub(initial_usage);
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!("Attach at least {} yoctoNEAR to cover storage", cost.as_yoctonear())
    );
    let refund = attached.saturating_sub(cost);
    if refund > NearToken::from_yoctonear(1) {
        Promise::new(env::predecessor_account_id()).transfer(refund).detach();
    }
}

/// Send the cost of storage freed since `initial_usage` to `to` (who paid for it).
fn refund_freed_storage(initial_usage: u64, to: &AccountId) {
    let freed = initial_usage.saturating_sub(env::storage_usage());
    let refund = env::storage_byte_cost().saturating_mul(freed as u128);
    if refund > NearToken::from_yoctonear(0) {
        Promise::new(to.clone()).transfer(refund).detach();
    }
}

/// Balance not locked for storage. During a call this includes the attached deposit.
fn free_balance() -> NearToken {
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    env::account_balance().saturating_sub(locked)
}

fn check_fee(fee_bps: u16) {
    require!(fee_bps <= MAX_FEE_BPS, format!("fee_bps must be at most {MAX_FEE_BPS}"));
}

fn check_text(title: &Option<String>, description: &Option<String>) {
    if let Some(t) = title {
        require!(t.len() <= MAX_TITLE_LEN, "title is too long");
    }
    if let Some(d) = description {
        require!(d.len() <= MAX_DESCRIPTION_LEN, "description is too long");
    }
}

/// Raw 32 bytes of an ed25519 key; panics for any other curve.
fn ed25519_bytes(key: &PublicKey) -> [u8; 32] {
    require!(key.curve_type() == CurveType::ED25519, "Only ed25519 keys can register");
    key.as_bytes()[1..]
        .try_into()
        .unwrap_or_else(|_| env::panic_str("Malformed ed25519 key"))
}

/// Checks a NEP-413 signature over `message` addressed to this contract.
pub fn verify_nep413(key: &PublicKey, message: &str, nonce: &[u8], signature: &[u8]) -> bool {
    let pk = ed25519_bytes(key);
    let nonce: [u8; 32] = nonce
        .try_into()
        .unwrap_or_else(|_| env::panic_str("nonce must be 32 bytes"));
    let sig: [u8; 64] = signature
        .try_into()
        .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
    let payload = Nep413Payload {
        message: message.to_string(),
        nonce,
        recipient: env::current_account_id().to_string(),
        callback_url: None,
    };
    let mut data = NEP413_TAG.to_le_bytes().to_vec();
    data.extend(borsh::to_vec(&payload).unwrap_or_else(|_| env::panic_str("Can't encode payload")));
    env::ed25519_verify(&sig, env::sha256_array(&data), &pk)
}

// ---------- registry ----------

#[near]
impl Contract {
    /// Only the registry account itself can initialise it: deploy and call `new` in one batch
    /// transaction, so nobody can front-run the init and make themselves owner.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId) -> Self {
        // `#[private]` isn't enforced in native unit tests; this keeps the guarantee testable.
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the registry account can initialise it"
        );
        Self::fresh(owner_id)
    }

    /// Mint a byline with a fresh random code to the caller, who pays its storage
    /// (the excess deposit is refunded). For human wallets and agents that hold a funded account.
    #[payable]
    pub fn register(
        &mut self,
        payout: Option<AccountId>,
        fee_bps: Option<u16>,
        title: Option<String>,
        description: Option<String>,
    ) -> BylineView {
        let fee_bps = fee_bps.unwrap_or(DEFAULT_FEE_BPS);
        check_fee(fee_bps);
        check_text(&title, &description);

        let initial = env::storage_usage();
        let owner = env::predecessor_account_id();
        let n = self.owner_counts.get(&owner).copied().unwrap_or(0);
        let code = self.free_code(format!("byline:v2:{owner}:{n}").as_bytes());
        self.owner_counts.insert(owner.clone(), n + 1);
        let payout = payout.unwrap_or_else(|| owner.clone());
        self.mint(&code, &owner, &payout, fee_bps, title, description, false);
        // Write the counter now so its storage is charged to the caller, not the registry.
        self.owner_counts.flush();
        settle_storage(initial);
        emit(
            "byline_registered",
            json!({ "code": code, "owner": owner, "payout": payout, "fee_bps": fee_bps, "via": "tx" }),
        );
        self.get_byline(code).unwrap()
    }

    /// Gasless onboarding for an agent that has only a key. The agent signs a NEP-413 message
    /// (`RegisterMessage` JSON, recipient = this contract); the relayer, holding a function-call key
    /// on this account, submits it. The registry verifies the signature, mints the byline to
    /// `<code>.<registry>`, then creates that account with the agent's key and `SPONSOR_SEED`.
    pub fn register_signed(
        &mut self,
        public_key: PublicKey,
        message: String,
        nonce: Base64VecU8,
        signature: Base64VecU8,
    ) -> Promise {
        // Only the relayer's function-call key on this account may submit: it rate-limits before paying.
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the registry's relayer can submit signed registrations"
        );
        require!(verify_nep413(&public_key, &message, &nonce.0, &signature.0), "Invalid signature");
        let msg: RegisterMessage = serde_json::from_str(&message)
            .unwrap_or_else(|_| env::panic_str("The signed message must be a register JSON object"));
        require!(msg.action == "register", "The signed message isn't a register request");
        let now = env::block_timestamp_ms();
        require!(msg.expires_at_ms > now, "The signed message has expired");
        require!(msg.expires_at_ms <= now + MAX_MESSAGE_TTL_MS, "The signed message lives too long (max 1 hour)");

        let key_str = String::from(&public_key);
        require!(self.key_index.get(&key_str).is_none(), "This key already has a byline");
        require!(self.sponsored_count < self.sponsor_limit, "Sponsored onboarding is full");
        let fee_bps = msg.fee_bps.unwrap_or(DEFAULT_FEE_BPS);
        check_fee(fee_bps);
        check_text(&msg.title, &msg.description);

        let mut seed = b"byline:v2:".to_vec();
        seed.extend(ed25519_bytes(&public_key));
        let code = self.free_code(&seed);
        let account_id: AccountId = format!("{}.{}", code, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("Resulting account id is invalid"));
        let payout = msg.payout.unwrap_or_else(|| account_id.clone());

        self.mint(&code, &account_id, &payout, fee_bps, msg.title, msg.description, true);
        let mut record = self.record(&code);
        record.account_pending = true;
        self.records.insert(code.clone(), record);
        self.key_index.insert(key_str.clone(), code.clone());
        self.sponsored_count += 1;
        self.records.flush();
        self.key_index.flush();

        // Stay solvent: the seed plus the storage just added must leave the registry's own storage covered.
        // The margin covers what the callback writes (account index, record) after the seed has left.
        require!(
            free_balance() >= SPONSOR_SEED.saturating_add(SOLVENCY_MARGIN),
            "The registry can't sponsor right now (balance too low)"
        );

        emit(
            "byline_registered",
            json!({ "code": code, "owner": account_id, "payout": payout, "fee_bps": fee_bps, "via": "signed", "public_key": key_str }),
        );
        Promise::new(account_id.clone())
            .create_account()
            .transfer(SPONSOR_SEED)
            .add_full_access_key(public_key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ACCOUNT_CALLBACK)
                    .on_signed_account_created(code, account_id, key_str),
            )
    }

    /// Callback for `register_signed`. Keeps the byline if the account exists; otherwise removes it
    /// and frees the sponsor slot (the seed came back to the registry with the failed receipt).
    #[private]
    pub fn on_signed_account_created(&mut self, code: String, account_id: AccountId, public_key: String) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        if ok {
            let mut record = self.record(&code);
            record.account_pending = false;
            record.account = Some(account_id.clone());
            self.records.insert(code.clone(), record);
            self.account_index.insert(account_id.clone(), code.clone());
            emit("account_created", json!({ "code": code, "account_id": account_id }));
            emit("account_linked", json!({ "code": code, "account_id": account_id }));
        } else {
            self.burn(&code, &account_id);
            self.key_index.remove(&public_key);
            self.sponsored_count = self.sponsored_count.saturating_sub(1);
            emit(
                "byline_revoked",
                json!({ "code": code, "account_id": account_id, "reason": "account_creation_failed" }),
            );
        }
        ok
    }

    /// Change payout, fee or text. Builder only; at least 1 yoctoNEAR (forces a full-access key).
    #[payable]
    pub fn update(
        &mut self,
        code: String,
        payout: Option<AccountId>,
        fee_bps: Option<u16>,
        title: Option<String>,
        description: Option<String>,
    ) -> BylineView {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Attach at least 1 yoctoNEAR"
        );
        self.assert_builder(&code);
        check_text(&title, &description);
        let initial = env::storage_usage();

        let mut record = self.record(&code);
        if let Some(p) = payout {
            record.payout = Some(p);
        }
        if let Some(f) = fee_bps {
            check_fee(f);
            record.fee_bps = f;
        }
        self.records.insert(code.clone(), record.clone());
        self.records.flush();

        if title.is_some() || description.is_some() {
            if let Some(meta_map) = self.tokens.token_metadata_by_id.as_mut() {
                let mut meta = meta_map.get(&code).unwrap_or_else(|| env::panic_str("Missing metadata"));
                if title.is_some() {
                    meta.title = title;
                }
                if description.is_some() {
                    meta.description = description;
                }
                meta.updated_at = Some(env::block_timestamp_ms().to_string());
                meta_map.insert(&code, &meta);
            }
        }
        settle_storage(initial);
        emit(
            "byline_updated",
            json!({ "code": code, "payout": record.payout, "fee_bps": record.fee_bps }),
        );
        self.get_byline(code).unwrap()
    }

    /// Create `<code>.<registry>` with `public_key` as a full-access key and link it.
    /// The deposit funds the new account (minus a small registry storage reserve).
    #[payable]
    pub fn create_account(&mut self, code: String, public_key: PublicKey) -> Promise {
        let builder = self.assert_builder(&code);
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_ACCOUNT_DEPOSIT,
            format!("Attach at least {} yoctoNEAR", MIN_ACCOUNT_DEPOSIT.as_yoctonear())
        );
        let mut record = self.record(&code);
        require!(record.account.is_none() && !record.account_pending, "This byline already has an account");
        // If creation fails, the callback refunds the builder before the failed transfer's money is back,
        // so the registry must hold that much of its own (beyond this deposit and its storage).
        require!(
            free_balance().saturating_sub(deposit) >= deposit.saturating_add(SOLVENCY_MARGIN),
            "The registry can't create accounts right now; try again later"
        );

        let account_id: AccountId = format!("{}.{}", code, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("Resulting account id is invalid"));
        record.account_pending = true;
        self.records.insert(code.clone(), record);
        self.records.flush();

        let funding = deposit.saturating_sub(ACCOUNT_STORAGE_RESERVE);
        Promise::new(account_id.clone())
            .create_account()
            .transfer(funding)
            .add_full_access_key(public_key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ACCOUNT_CALLBACK)
                    .on_account_created(code, account_id, builder, U128(deposit.as_yoctonear())),
            )
    }

    /// Callback for `create_account`. On failure, clears the pending flag and refunds the builder.
    #[private]
    pub fn on_account_created(
        &mut self,
        code: String,
        account_id: AccountId,
        builder: AccountId,
        deposit: U128,
    ) -> bool {
        // create_account returns no value, so a 0-byte bound is enough to read success/failure.
        let ok = env::promise_result_checked(0, 0).is_ok();
        let mut record = self.record(&code);
        record.account_pending = false;
        if ok {
            record.account = Some(account_id.clone());
            self.account_index.insert(account_id.clone(), code.clone());
            emit("account_created", json!({ "code": code, "account_id": account_id }));
            emit("account_linked", json!({ "code": code, "account_id": account_id }));
        } else {
            // The failed create/transfer returned the funding to this contract; give it all back.
            Promise::new(builder.clone())
                .transfer(NearToken::from_yoctonear(deposit.0))
                .detach();
            emit(
                "account_creation_failed",
                json!({ "code": code, "account_id": account_id, "refunded_to": builder }),
            );
        }
        self.records.insert(code, record);
        ok
    }

    /// Builder invites an existing account to link itself to this byline.
    #[payable]
    pub fn invite_account(&mut self, code: String, account_id: AccountId) {
        self.assert_builder(&code);
        let mut record = self.record(&code);
        require!(!record.invited.contains(&account_id), "Already invited");
        require!(
            self.account_index.get(&account_id).is_none(),
            "This account is already linked to a byline"
        );
        require!(
            record.linked.len() + record.invited.len() < MAX_LINKED,
            format!("At most {MAX_LINKED} linked or invited accounts per byline")
        );
        let initial = env::storage_usage();
        record.invited.push(account_id.clone());
        self.records.insert(code.clone(), record);
        self.records.flush();
        settle_storage(initial);
        emit("account_invited", json!({ "code": code, "account_id": account_id }));
    }

    /// Called by an invited account itself to link to the byline.
    #[payable]
    pub fn link_account(&mut self, code: String) {
        let account_id = env::predecessor_account_id();
        // `<code>.<registry>` accounts belong to their own byline; the registry links them itself.
        require!(
            !account_id.as_str().ends_with(&format!(".{}", env::current_account_id())),
            "Registry-created accounts can't link to another byline"
        );
        let mut record = self.record(&code);
        require!(record.invited.contains(&account_id), "This account was not invited by the byline's builder");
        require!(
            self.account_index.get(&account_id).is_none(),
            "This account is already linked to a byline; unlink it first"
        );
        let initial = env::storage_usage();
        record.invited.retain(|a| a != &account_id);
        record.linked.push(account_id.clone());
        self.records.insert(code.clone(), record);
        self.account_index.insert(account_id.clone(), code.clone());
        self.records.flush();
        self.account_index.flush();
        settle_storage(initial);
        emit("account_linked", json!({ "code": code, "account_id": account_id }));
    }

    /// Unlink an account. Callable by the account itself or by the byline's builder, with exactly
    /// 1 yoctoNEAR (a full-access key). The freed storage goes back to the unlinked account, which paid it.
    /// The byline's own `<code>.<registry>` account can't be unlinked.
    #[payable]
    pub fn unlink_account(&mut self, account_id: AccountId) {
        assert_one_yocto();
        let initial = env::storage_usage();
        let code = self
            .account_index
            .get(&account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("This account is not linked"));
        let caller = env::predecessor_account_id();
        let owner = self.owner_of(&code);
        require!(caller == account_id || caller == owner, "Only the account or the builder can unlink");
        let mut record = self.record(&code);
        require!(record.account.as_ref() != Some(&account_id), "The byline's own account can't be unlinked");
        record.linked.retain(|a| a != &account_id);
        self.records.insert(code.clone(), record);
        self.account_index.remove(&account_id);
        self.records.flush();
        self.account_index.flush();
        refund_freed_storage(initial, &account_id);
        emit("account_unlinked", json!({ "code": code, "account_id": account_id, "reason": "unlink" }));
    }

    /// Builder withdraws an invite that wasn't accepted. Exactly 1 yoctoNEAR; the freed storage
    /// goes back to the builder, who paid for the invite.
    #[payable]
    pub fn cancel_invite(&mut self, code: String, account_id: AccountId) {
        assert_one_yocto();
        let builder = self.assert_builder(&code);
        let initial = env::storage_usage();
        let mut record = self.record(&code);
        require!(record.invited.contains(&account_id), "That account isn't invited");
        record.invited.retain(|a| a != &account_id);
        self.records.insert(code.clone(), record);
        self.records.flush();
        refund_freed_storage(initial, &builder);
        emit("invite_cancelled", json!({ "code": code, "account_id": account_id }));
    }

    /// Owner only, with exactly 1 yoctoNEAR (a full-access key): how many agents the registry sponsors in total.
    #[payable]
    pub fn set_sponsor_limit(&mut self, limit: u32) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.tokens.owner_id, "Only the registry owner can do this");
        self.sponsor_limit = limit;
        emit("sponsor_limit_set", json!({ "limit": limit, "used": self.sponsored_count }));
    }

    // ---------- views ----------

    pub fn get_byline(&self, code: String) -> Option<BylineView> {
        let record = self.records.get(&code)?.clone();
        let owner = self.tokens.owner_by_id.get(&code)?;
        let meta = self
            .tokens
            .token_metadata_by_id
            .as_ref()
            .and_then(|m| m.get(&code));
        Some(BylineView {
            code,
            owner,
            payout: record.payout,
            fee_bps: record.fee_bps,
            account: record.account,
            account_pending: record.account_pending,
            linked: record.linked,
            invited: record.invited,
            created_at_ms: record.created_at_ms,
            sponsored: record.sponsored,
            title: meta.as_ref().and_then(|m| m.title.clone()),
            description: meta.and_then(|m| m.description),
        })
    }

    /// Bylines in mint order.
    pub fn get_bylines(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<BylineView> {
        self.tokens
            .nft_tokens(from_index, limit)
            .into_iter()
            .filter_map(|t| self.get_byline(t.token_id))
            .collect()
    }

    pub fn get_bylines_for_owner(
        &self,
        owner_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<BylineView> {
        self.tokens
            .nft_tokens_for_owner(owner_id, from_index, limit)
            .into_iter()
            .filter_map(|t| self.get_byline(t.token_id))
            .collect()
    }

    /// The byline an account's activity counts for, if any.
    pub fn get_byline_for_account(&self, account_id: AccountId) -> Option<String> {
        self.account_index.get(&account_id).cloned()
    }

    /// The sponsored byline registered with this key, if any.
    pub fn get_byline_for_key(&self, public_key: PublicKey) -> Option<String> {
        self.key_index.get(&String::from(&public_key)).cloned()
    }

    /// The fields the SDK copies into a 1Click quote request.
    pub fn get_attribution(&self, code: String) -> Option<Attribution> {
        let record = self.records.get(&code)?;
        let app_fees = match (&record.payout, record.fee_bps) {
            (Some(recipient), fee) if fee > 0 => vec![AppFee { recipient: recipient.clone(), fee }],
            _ => vec![],
        };
        Some(Attribution { referral: code, app_fees })
    }

    pub fn get_sponsor_status(&self) -> SponsorStatus {
        SponsorStatus {
            used: self.sponsored_count,
            limit: self.sponsor_limit,
            seed: U128(SPONSOR_SEED.as_yoctonear()),
        }
    }

    // ---------- internal ----------

    fn fresh(owner_id: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Byline".to_string(),
            symbol: "BYLINE".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(P_OWNERS, owner_id, Some(P_META), Some(P_ENUM), None::<&[u8]>),
            metadata,
            records: LookupMap::new(P_RECORDS),
            account_index: LookupMap::new(P_ACCOUNTS),
            key_index: LookupMap::new(P_KEYS),
            owner_counts: LookupMap::new(P_COUNTS),
            sponsored_count: 0,
            sponsor_limit: DEFAULT_SPONSOR_LIMIT,
        }
    }

    /// A code derived from `seed` that isn't taken yet. The first try is deterministic (same key,
    /// same code); on a collision the fallbacks mix in the block's random seed, so nobody can
    /// pre-register them to lock a key or wallet out.
    fn free_code(&self, seed: &[u8]) -> String {
        let first = code_from_seed(seed);
        if self.records.get(&first).is_none() {
            return first;
        }
        let random = env::random_seed();
        for i in 1..32u32 {
            let mut s = seed.to_vec();
            s.extend_from_slice(&random);
            s.extend(format!("#{i}").as_bytes());
            let code = code_from_seed(&s);
            if self.records.get(&code).is_none() {
                return code;
            }
        }
        env::panic_str("Couldn't find a free code; try again")
    }

    #[allow(clippy::too_many_arguments)]
    fn mint(
        &mut self,
        code: &str,
        owner: &AccountId,
        payout: &AccountId,
        fee_bps: u16,
        title: Option<String>,
        description: Option<String>,
        sponsored: bool,
    ) {
        let metadata = TokenMetadata {
            title,
            description,
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        };
        self.tokens
            .internal_mint_with_refund(code.to_string(), owner.clone(), Some(metadata), None);
        // `internal_mint_with_refund` doesn't log the standard event; wallets and explorers need it.
        NftMint { owner_id: owner, token_ids: &[code], memo: None }.emit();
        self.records.insert(
            code.to_string(),
            Record {
                payout: Some(payout.clone()),
                fee_bps,
                account: None,
                account_pending: false,
                linked: vec![],
                invited: vec![],
                created_at_ms: env::block_timestamp_ms(),
                sponsored,
            },
        );
        self.records.flush();
    }

    /// Remove a byline entirely. Only used to roll back a sponsored registration whose account failed.
    fn burn(&mut self, code: &str, owner: &AccountId) {
        let token_id = code.to_string();
        self.tokens.owner_by_id.remove(&token_id);
        if let Some(meta) = self.tokens.token_metadata_by_id.as_mut() {
            meta.remove(&token_id);
        }
        if let Some(per_owner) = self.tokens.tokens_per_owner.as_mut() {
            if let Some(mut set) = per_owner.get(owner) {
                set.remove(&token_id);
                if set.is_empty() {
                    per_owner.remove(owner);
                } else {
                    per_owner.insert(owner, &set);
                }
            }
        }
        self.records.remove(code);
        NftBurn { owner_id: owner, token_ids: &[code], authorized_id: None, memo: None }.emit();
    }

    fn record(&self, code: &str) -> Record {
        self.records
            .get(code)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No such byline"))
    }

    fn owner_of(&self, code: &str) -> AccountId {
        self.tokens
            .owner_by_id
            .get(&code.to_string())
            .unwrap_or_else(|| env::panic_str("No such byline"))
    }

    fn assert_builder(&self, code: &str) -> AccountId {
        let owner = self.owner_of(code);
        require!(env::predecessor_account_id() == owner, "Only the byline's builder can do this");
        owner
    }
}

// ---------- NEP-171 core: views work, transfers are refused ----------

#[near]
impl NonFungibleTokenCore for Contract {
    /// Always panics: bylines can't change hands.
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str(NON_TRANSFERABLE)
    }

    /// Always panics: bylines can't change hands.
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str(NON_TRANSFERABLE)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

// ---------- unit tests ----------

#[cfg(test)]
mod tests;
