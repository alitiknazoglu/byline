use super::*;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const REGISTRY: &str = "byline.testnet";
/// Signed with near-kit by scripts/make-nep413-fixture.mjs (TEST ONLY keys).
const FIXTURE: &str = include_str!("../../fixtures/nep413-register.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn expires() -> u64 {
    fixture()["expires_at_ms"].as_u64().unwrap()
}

fn registry() -> AccountId {
    REGISTRY.parse().unwrap()
}

/// Context at a block time just inside the signed messages' validity window.
fn ctx(predecessor: &AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(registry())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .attached_deposit(deposit)
        .block_timestamp((expires() - 10 * 60 * 1000) * 1_000_000)
        .account_balance(NearToken::from_near(100));
    b
}

fn as_(who: &AccountId, deposit: NearToken) {
    testing_env!(ctx(who, deposit).build());
}

fn at_time(who: &AccountId, ms: u64) {
    testing_env!(ctx(who, NearToken::from_yoctonear(0)).block_timestamp(ms * 1_000_000).build());
}

fn callback(result: PromiseResult) {
    testing_env!(
        ctx(&registry(), NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn setup() -> Contract {
    as_(&registry(), NearToken::from_yoctonear(0));
    Contract::new(registry())
}

fn register(c: &mut Contract, who: &AccountId) -> String {
    as_(who, NearToken::from_millinear(100));
    c.register(None, None, None, None).code
}

fn signed(c: &mut Contract, entry: &str) -> String {
    let f = fixture();
    let e = &f[entry];
    as_(&registry(), NearToken::from_yoctonear(0));
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().to_string(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(base64_decode(e["signature"].as_str().unwrap())),
    );
    e["expected_code"].as_str().unwrap_or_default().to_string()
}

fn base64_decode(s: &str) -> Vec<u8> {
    serde_json::from_value::<Base64VecU8>(Value::String(s.to_string())).unwrap().0
}

fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

// ---------- codes ----------

#[test]
fn codes_match_the_sdk_and_have_the_right_shape() {
    let f = fixture();
    for (seed, code) in f["tx_path_codes"].as_object().unwrap() {
        let derived = code_from_seed(format!("byline:v2:{seed}").as_bytes());
        assert_eq!(derived, code.as_str().unwrap(), "seed {seed}");
        assert!(is_valid_code(&derived));
    }
    assert!(!is_valid_code("acme-trader"));
    assert!(!is_valid_code("abcdefgi")); // 'i' isn't in the alphabet
    assert!(!is_valid_code("abc"));
}

// ---------- register (wallet path) ----------

#[test]
fn register_generates_a_new_code_per_registration() {
    let mut c = setup();
    let alice: AccountId = "alice.near".parse().unwrap();
    let first = register(&mut c, &alice);
    let second = register(&mut c, &alice);
    let f = fixture();
    assert_eq!(first, f["tx_path_codes"]["alice.near:0"].as_str().unwrap());
    assert_eq!(second, f["tx_path_codes"]["alice.near:1"].as_str().unwrap());

    let v = c.get_byline(first.clone()).unwrap();
    assert_eq!(v.owner, alice);
    assert_eq!(v.payout, Some(alice.clone()));
    assert_eq!(v.fee_bps, DEFAULT_FEE_BPS);
    assert!(!v.sponsored);
    let a = c.get_attribution(first.clone()).unwrap();
    assert_eq!(a.referral, first);
    assert_eq!(a.app_fees, vec![AppFee { recipient: alice, fee: DEFAULT_FEE_BPS }]);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"byline_registered\"") && l.contains("\"via\":\"tx\"")));
    assert!(logs.iter().any(|l| l.contains("\"nft_mint\"")));
}

#[test]
#[should_panic(expected = "fee_bps must be at most")]
fn register_high_fee_fails() {
    let mut c = setup();
    as_(&accounts(0), NearToken::from_millinear(100));
    c.register(None, Some(101), None, None);
}

#[test]
#[should_panic(expected = "to cover storage")]
fn register_without_deposit_fails() {
    let mut c = setup();
    as_(&accounts(0), NearToken::from_yoctonear(0));
    c.register(None, None, None, None);
}

// ---------- register_signed (gasless path) ----------

#[test]
fn signed_registration_mints_to_the_agents_own_account() {
    let mut c = setup();
    let code = signed(&mut c, "agent_a");
    let account: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    let v = c.get_byline(code.clone()).unwrap();
    assert_eq!(v.owner, account);
    assert_eq!(v.payout, Some(account.clone()));
    assert!(v.sponsored);
    assert!(v.account_pending);
    assert_eq!(v.title.as_deref(), Some("Fixture agent A"));
    assert_eq!(c.get_sponsor_status().used, 1);
    let key: PublicKey = fixture()["agent_a"]["public_key"].as_str().unwrap().parse().unwrap();
    assert_eq!(c.get_byline_for_key(key), Some(code.clone()));
    assert!(get_logs().iter().any(|l| l.contains("\"via\":\"signed\"")));

    callback(PromiseResult::Successful(vec![]));
    let a: AccountId = account.clone();
    assert!(c.on_signed_account_created(code.clone(), a, fixture()["agent_a"]["public_key"].as_str().unwrap().into()));
    let v = c.get_byline(code.clone()).unwrap();
    assert_eq!(v.account, Some(account.clone()));
    assert!(!v.account_pending);
    assert_eq!(c.get_byline_for_account(account.clone()), Some(code.clone()));

    // The agent owns its byline through its own account, so it can update it itself.
    as_(&account, NearToken::from_millinear(10));
    let v = c.update(code, Some("alice.near".parse().unwrap()), None, None, None);
    assert_eq!(v.payout, Some("alice.near".parse().unwrap()));
}

#[test]
fn signed_registration_can_pay_a_human() {
    let mut c = setup();
    let code = signed(&mut c, "agent_a_with_payout");
    let v = c.get_byline(code).unwrap();
    assert_eq!(v.payout, Some("alice.near".parse().unwrap()));
    assert_eq!(v.fee_bps, 30);
}

#[test]
#[should_panic(expected = "Invalid signature")]
fn signed_registration_rejects_a_bad_signature() {
    let mut c = setup();
    let f = fixture();
    let e = &f["agent_a"];
    let mut sig = base64_decode(e["signature"].as_str().unwrap());
    sig[0] ^= 1;
    as_(&registry(), NearToken::from_yoctonear(0));
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().into(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(sig),
    );
}

#[test]
#[should_panic(expected = "Invalid signature")]
fn signed_registration_rejects_another_recipient() {
    let mut c = setup();
    signed(&mut c, "wrong_recipient");
}

#[test]
#[should_panic(expected = "isn't a register request")]
fn signed_registration_rejects_other_actions() {
    let mut c = setup();
    signed(&mut c, "wrong_action");
}

#[test]
#[should_panic(expected = "has expired")]
fn signed_registration_rejects_expired_messages() {
    let mut c = setup();
    let f = fixture();
    let e = &f["agent_a"];
    at_time(&registry(), expires() + 1);
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().into(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(base64_decode(e["signature"].as_str().unwrap())),
    );
}

#[test]
#[should_panic(expected = "lives too long")]
fn signed_registration_rejects_long_lived_messages() {
    let mut c = setup();
    let f = fixture();
    let e = &f["agent_a"];
    at_time(&registry(), expires() - 2 * 60 * 60 * 1000);
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().into(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(base64_decode(e["signature"].as_str().unwrap())),
    );
}

#[test]
#[should_panic(expected = "already has a byline")]
fn one_sponsored_byline_per_key() {
    let mut c = setup();
    signed(&mut c, "agent_a");
    signed(&mut c, "agent_a_with_payout");
}

#[test]
#[should_panic(expected = "Sponsored onboarding is full")]
fn sponsor_quota_is_enforced() {
    let mut c = setup();
    as_(&registry(), NearToken::from_yoctonear(1));
    c.set_sponsor_limit(1);
    signed(&mut c, "agent_a");
    signed(&mut c, "agent_b");
}

#[test]
#[should_panic(expected = "Only the registry owner")]
fn sponsor_limit_is_owner_only() {
    let mut c = setup();
    as_(&accounts(1), NearToken::from_yoctonear(1));
    c.set_sponsor_limit(1000);
}

#[test]
#[should_panic(expected = "Only the registry's relayer")]
fn only_the_relayer_key_can_submit() {
    let mut c = setup();
    let f = fixture();
    let e = &f["agent_a"];
    as_(&accounts(1), NearToken::from_yoctonear(0));
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().into(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(base64_decode(e["signature"].as_str().unwrap())),
    );
}

#[test]
fn failed_account_creation_rolls_back_and_frees_the_slot() {
    let mut c = setup();
    let code = signed(&mut c, "agent_a");
    let key = fixture()["agent_a"]["public_key"].as_str().unwrap().to_string();
    let account: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    callback(PromiseResult::Failed);
    assert!(!c.on_signed_account_created(code.clone(), account.clone(), key.clone()));
    assert!(c.get_byline(code.clone()).is_none());
    assert_eq!(c.nft_total_supply(), U128(0));
    assert_eq!(c.nft_supply_for_owner(account), U128(0));
    assert_eq!(c.get_sponsor_status().used, 0);
    assert_eq!(c.get_byline_for_key(key.parse().unwrap()), None);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"byline_revoked\"")));
    assert!(logs.iter().any(|l| l.contains("\"nft_burn\"")));
    // The same key can try again.
    assert_eq!(signed(&mut c, "agent_a"), code);
}

// ---------- update, accounts, links (unchanged behaviour, keyed by code) ----------

#[test]
fn update_payout_and_fee() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(10));
    let v = c.update(code.clone(), Some(accounts(3)), Some(0), Some("Acme Bot".into()), None);
    assert_eq!(v.payout, Some(accounts(3)));
    assert_eq!(v.fee_bps, 0);
    assert_eq!(v.title.as_deref(), Some("Acme Bot"));
    let a = c.get_attribution(code.clone()).unwrap();
    assert!(a.app_fees.is_empty());
    assert_eq!(a.referral, code);
}

#[test]
#[should_panic(expected = "Only the byline's builder")]
fn update_by_stranger_fails() {
    let mut c = setup();
    let code = register(&mut c, &accounts(0));
    as_(&accounts(1), NearToken::from_yoctonear(1));
    c.update(code, Some(accounts(1)), None, None, None);
}

#[test]
#[should_panic(expected = "Attach at least 1 yoctoNEAR")]
fn update_without_yocto_fails() {
    let mut c = setup();
    let code = register(&mut c, &accounts(0));
    as_(&accounts(0), NearToken::from_yoctonear(0));
    c.update(code, Some(accounts(1)), None, None, None);
}

#[test]
fn invite_link_unlink() {
    let mut c = setup();
    let (alice, bot) = (accounts(0), accounts(1));
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(code.clone(), bot.clone());
    as_(&bot, NearToken::from_millinear(10));
    c.link_account(code.clone());
    let v = c.get_byline(code.clone()).unwrap();
    assert_eq!(v.linked, vec![bot.clone()]);
    assert_eq!(c.get_byline_for_account(bot.clone()), Some(code));
    as_(&bot, NearToken::from_yoctonear(1));
    c.unlink_account(bot.clone());
    assert_eq!(c.get_byline_for_account(bot), None);
}

#[test]
#[should_panic(expected = "was not invited")]
fn link_without_invite_fails() {
    let mut c = setup();
    let code = register(&mut c, &accounts(0));
    as_(&accounts(1), NearToken::from_millinear(10));
    c.link_account(code);
}

#[test]
#[should_panic(expected = "already linked")]
fn link_to_two_bylines_fails() {
    let mut c = setup();
    let (alice, carol, bot) = (accounts(0), accounts(2), accounts(1));
    let a = register(&mut c, &alice);
    let b = register(&mut c, &carol);
    for (who, code) in [(&alice, &a), (&carol, &b)] {
        as_(who, NearToken::from_millinear(10));
        c.invite_account(code.clone(), bot.clone());
    }
    as_(&bot, NearToken::from_millinear(10));
    c.link_account(a);
    c.link_account(b);
}

#[test]
#[should_panic(expected = "non-transferable")]
fn nft_transfer_is_refused() {
    let mut c = setup();
    let code = register(&mut c, &accounts(0));
    as_(&accounts(0), NearToken::from_yoctonear(1));
    c.nft_transfer(accounts(2), code, None, None);
}

#[test]
#[should_panic(expected = "non-transferable")]
fn nft_transfer_call_is_refused() {
    let mut c = setup();
    let code = register(&mut c, &accounts(0));
    as_(&accounts(0), NearToken::from_yoctonear(1));
    let _ = c.nft_transfer_call(accounts(2), code, None, None, String::new());
}

#[test]
fn create_account_success_links_subaccount() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(50));
    let _ = c.create_account(code.clone(), pk());
    assert!(c.get_byline(code.clone()).unwrap().account_pending);
    callback(PromiseResult::Successful(vec![]));
    let sub: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    assert!(c.on_account_created(code.clone(), sub.clone(), alice, U128(50)));
    assert_eq!(c.get_byline(code.clone()).unwrap().account, Some(sub.clone()));
    assert_eq!(c.get_byline_for_account(sub), Some(code));
}

#[test]
#[should_panic(expected = "own account can't be unlinked")]
fn subaccount_cannot_be_unlinked() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(50));
    let _ = c.create_account(code.clone(), pk());
    callback(PromiseResult::Successful(vec![]));
    let sub: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    c.on_account_created(code, sub.clone(), alice.clone(), U128(50));
    as_(&alice, NearToken::from_yoctonear(1));
    c.unlink_account(sub);
}

#[test]
fn create_account_failure_clears_pending() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(50));
    let _ = c.create_account(code.clone(), pk());
    callback(PromiseResult::Failed);
    let sub: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    assert!(!c.on_account_created(code.clone(), sub, alice, U128(50)));
    let v = c.get_byline(code).unwrap();
    assert_eq!(v.account, None);
    assert!(!v.account_pending);
}

#[test]
#[should_panic(expected = "already has an account")]
fn sponsored_byline_cannot_get_a_second_account() {
    let mut c = setup();
    let code = signed(&mut c, "agent_a");
    let account: AccountId = format!("{code}.{REGISTRY}").parse().unwrap();
    callback(PromiseResult::Successful(vec![]));
    c.on_signed_account_created(code.clone(), account.clone(), fixture()["agent_a"]["public_key"].as_str().unwrap().into());
    as_(&account, NearToken::from_millinear(50));
    let _ = c.create_account(code, pk());
}

#[test]
fn listing_views() {
    let mut c = setup();
    let a = register(&mut c, &accounts(0));
    let b = register(&mut c, &accounts(0));
    register(&mut c, &accounts(1));
    assert_eq!(c.get_bylines(None, None).len(), 3);
    let mine: Vec<String> = c.get_bylines_for_owner(accounts(0), None, None).into_iter().map(|v| v.code).collect();
    assert_eq!(mine, vec![a, b]);
}

// ---------- pre-mainnet hardening ----------

#[test]
#[should_panic(expected = "Only the registry account can initialise it")]
fn only_the_registry_can_initialise() {
    as_(&accounts(1), NearToken::from_yoctonear(0));
    let _ = Contract::new(accounts(1));
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn sponsor_limit_needs_a_full_access_key() {
    let mut c = setup();
    as_(&registry(), NearToken::from_yoctonear(0));
    c.set_sponsor_limit(5);
}

#[test]
fn default_sponsor_limit_is_small() {
    let c = setup();
    assert_eq!(c.get_sponsor_status().limit, 20);
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn unlink_needs_a_full_access_key() {
    let mut c = setup();
    let (alice, bot) = (accounts(0), accounts(1));
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(code.clone(), bot.clone());
    as_(&bot, NearToken::from_millinear(10));
    c.link_account(code);
    as_(&bot, NearToken::from_yoctonear(0));
    c.unlink_account(bot);
}

#[test]
fn builder_can_cancel_an_invite() {
    let mut c = setup();
    let (alice, bot) = (accounts(0), accounts(1));
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(code.clone(), bot.clone());
    assert_eq!(c.get_byline(code.clone()).unwrap().invited, vec![bot.clone()]);
    as_(&alice, NearToken::from_yoctonear(1));
    c.cancel_invite(code.clone(), bot.clone());
    assert!(c.get_byline(code.clone()).unwrap().invited.is_empty());
    // The cancelled account can no longer link.
    as_(&bot, NearToken::from_millinear(10));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.link_account(code)));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "Only the byline's builder")]
fn only_the_builder_can_cancel_an_invite() {
    let mut c = setup();
    let (alice, bot) = (accounts(0), accounts(1));
    let code = register(&mut c, &alice);
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(code.clone(), bot.clone());
    as_(&bot, NearToken::from_yoctonear(1));
    c.cancel_invite(code, bot);
}

#[test]
#[should_panic(expected = "already linked to a byline")]
fn cannot_invite_an_already_linked_account() {
    let mut c = setup();
    let (alice, carol, bot) = (accounts(0), accounts(2), accounts(1));
    let a = register(&mut c, &alice);
    let b = register(&mut c, &carol);
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(a.clone(), bot.clone());
    as_(&bot, NearToken::from_millinear(10));
    c.link_account(a);
    as_(&carol, NearToken::from_millinear(10));
    c.invite_account(b, bot);
}

#[test]
#[should_panic(expected = "Registry-created accounts can't link")]
fn registry_accounts_cannot_link_elsewhere() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    let agent: AccountId = format!("zzzzzzzz.{REGISTRY}").parse().unwrap();
    as_(&alice, NearToken::from_millinear(10));
    c.invite_account(code.clone(), agent.clone());
    as_(&agent, NearToken::from_millinear(10));
    c.link_account(code);
}

#[test]
#[should_panic(expected = "balance too low")]
fn sponsoring_keeps_a_margin() {
    let mut c = setup();
    let f = fixture();
    let e = &f["agent_a"];
    // Enough for the seed but not the margin on top of locked storage.
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    testing_env!(ctx(&registry(), NearToken::from_yoctonear(0))
        .account_balance(locked.saturating_add(SPONSOR_SEED))
        .build());
    let _ = c.register_signed(
        e["public_key"].as_str().unwrap().parse().unwrap(),
        e["message"].as_str().unwrap().to_string(),
        Base64VecU8(base64_decode(e["nonce"].as_str().unwrap())),
        Base64VecU8(base64_decode(e["signature"].as_str().unwrap())),
    );
}

#[test]
#[should_panic(expected = "can't create accounts right now")]
fn create_account_needs_a_refund_float() {
    let mut c = setup();
    let alice = accounts(0);
    let code = register(&mut c, &alice);
    // The registry holds only its storage plus this deposit: a failed creation couldn't be refunded in time.
    let deposit = NearToken::from_millinear(50);
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    testing_env!(ctx(&alice, deposit).account_balance(locked.saturating_add(deposit)).build());
    let _ = c.create_account(code, pk());
}

#[test]
fn register_charges_the_owner_counter_to_the_caller() {
    let mut c = setup();
    let alice = accounts(0);
    as_(&alice, NearToken::from_millinear(100));
    let before = env::storage_usage();
    c.register(None, None, None, None);
    // The counter is written inside the call, so it is part of what settle_storage charged.
    let after_call = env::storage_usage();
    c.owner_counts.flush();
    assert_eq!(env::storage_usage(), after_call, "owner_counts had unflushed writes after register");
    assert!(after_call > before);
}
