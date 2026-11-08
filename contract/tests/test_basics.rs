//! Sandbox integration tests: a real local NEAR node, the real wasm, real receipts.

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(account_id.clone().as_str().parse()?)
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

/// What an agent's SDK does: sign a register message for `recipient` with its own key (NEP-413).
fn sign_register(key: &SigningKey, recipient: &str, extra: Value) -> (String, Value) {
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let mut msg = json!({ "action": "register", "expires_at_ms": now_ms + 30 * 60 * 1000 });
    msg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let message = msg.to_string();
    let nonce = [7u8; 32];
    let payload = Nep413Payload { message: message.clone(), nonce, recipient: recipient.into(), callback_url: None };
    let mut data = 2_147_484_061u32.to_le_bytes().to_vec();
    data.extend(borsh::to_vec(&payload).unwrap());
    let sig = key.sign(&Sha256::digest(&data));
    let public_key = format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string());
    let b64 = |b: &[u8]| near_sdk::serde_json::to_value(near_sdk::json_types::Base64VecU8(b.to_vec())).unwrap();
    let args = json!({ "public_key": public_key, "message": message, "nonce": b64(&nonce), "signature": b64(&sig.to_bytes()) });
    (public_key, args)
}

async fn run(contract_wasm: Vec<u8>) -> testresult::TestResult<()> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
    )?;

    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let registry = create_subaccount(&sandbox, "registry.sandbox").await?.as_contract();

    near_api::Contract::deploy(registry.account_id().clone())
        .use_code(contract_wasm)
        .with_init_call("new", json!({ "owner_id": registry.account_id() }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let view = |method: &'static str, args: Value| {
        let registry = registry.clone();
        let net = net.clone();
        async move {
            Ok::<Value, Box<dyn std::error::Error>>(
                registry.call_function(method, args).read_only().fetch_from(&net).await?.data,
            )
        }
    };

    // ---- wallet path: Alice registers; the registry picks the code; only storage is kept ----
    let before = alice.tokens().near_balance().fetch_from(&net).await?.total;
    let reg = registry
        .call_function("register", json!({ "title": "Alice's DCA bot" }))
        .transaction()
        .deposit(NearToken::from_millinear(100))
        .gas(NearGas::from_tgas(50))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?;
    reg.assert_success();
    let spent = before.saturating_sub(alice.tokens().near_balance().fetch_from(&net).await?.total);
    assert!(spent < NearToken::from_millinear(20), "register should refund the excess, spent {spent}");

    let mine = view("get_bylines_for_owner", json!({ "owner_id": alice.account_id() })).await?;
    let code = mine[0]["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 8, "code {code}");
    assert_eq!(mine[0]["payout"], json!(alice.account_id()));
    assert_eq!(mine[0]["title"], json!("Alice's DCA bot"));

    // A second registration from the same wallet gets a different code.
    registry
        .call_function("register", json!({}))
        .transaction()
        .deposit(NearToken::from_millinear(100))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let mine = view("get_bylines_for_owner", json!({ "owner_id": alice.account_id() })).await?;
    assert_eq!(mine.as_array().unwrap().len(), 2);
    assert_ne!(mine[1]["code"], json!(code));

    // Alice gives the agent its own account.
    registry
        .call_function("create_account", json!({ "code": code, "public_key": PK }))
        .transaction()
        .deposit(NearToken::from_millinear(50))
        .gas(NearGas::from_tgas(100))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let sub: AccountId = format!("{code}.registry.sandbox").parse()?;
    let bal = near_api::Account(sub.clone()).tokens().near_balance().fetch_from(&net).await?.total;
    assert_eq!(bal, NearToken::from_millinear(48));
    assert_eq!(view("get_byline_for_account", json!({ "account_id": sub })).await?, json!(code));

    let a = view("get_attribution", json!({ "code": code })).await?;
    assert_eq!(a["referral"], json!(code));
    assert_eq!(a["app_fees"], json!([{ "recipient": alice.account_id(), "fee": 40 }]));

    // Non-transferable; only the builder can update.
    registry
        .call_function("nft_transfer", json!({ "receiver_id": bob.account_id(), "token_id": code }))
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();
    registry
        .call_function("update", json!({ "code": code, "payout": bob.account_id() }))
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // ---- gasless path: an agent with only a key onboards itself ----
    let agent_key = SigningKey::from_bytes(&[42u8; 32]);
    let (agent_pk, args) = sign_register(&agent_key, "registry.sandbox", json!({ "title": "Keypair-only agent" }));

    // Someone other than the registry's relayer key can't submit it.
    registry
        .call_function("register_signed", args.clone())
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // The relayer (a key on the registry account) submits it; the registry pays.
    registry
        .call_function("register_signed", args.clone())
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(registry.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let agent_code = view("get_byline_for_key", json!({ "public_key": agent_pk })).await?;
    let agent_code = agent_code.as_str().expect("the key should have a byline").to_string();
    let agent_account: AccountId = format!("{agent_code}.registry.sandbox").parse()?;
    let b = view("get_byline", json!({ "code": agent_code })).await?;
    assert_eq!(b["owner"], json!(agent_account));
    assert_eq!(b["account"], json!(agent_account));
    assert_eq!(b["account_pending"], json!(false));
    assert_eq!(b["sponsored"], json!(true));
    let bal = near_api::Account(agent_account.clone()).tokens().near_balance().fetch_from(&net).await?.total;
    assert_eq!(bal, NearToken::from_millinear(30), "the agent account starts with the sponsor seed");
    assert_eq!(view("get_sponsor_status", json!({})).await?["used"], json!(1));

    // The agent now controls its own account with its own key and can update its byline itself.
    let mut secret = agent_key.to_bytes().to_vec();
    secret.extend(agent_key.verifying_key().as_bytes());
    let agent_signer = near_api::Signer::from_secret_key(format!("ed25519:{}", bs58::encode(secret).into_string()).parse()?)?;
    let keys = near_api::Account(agent_account.clone()).list_keys().fetch_from(&net).await?;
    assert_eq!(keys.data.iter().map(|k| k.0.to_string()).collect::<Vec<_>>(), vec![agent_pk.clone()], "only the agent's key controls its account");
    // 10 Tgas: a sponsored account's small balance must cover the pessimistic gas reservation.
    registry
        .call_function("update", json!({ "code": agent_code, "payout": alice.account_id() }))
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .gas(NearGas::from_tgas(10))
        .with_signer(agent_account.clone(), agent_signer)
        .send_to(&net)
        .await?
        .assert_success();
    let a = view("get_attribution", json!({ "code": agent_code })).await?;
    assert_eq!(a["app_fees"], json!([{ "recipient": alice.account_id(), "fee": 40 }]));

    // Replaying the same signed message does nothing new.
    registry
        .call_function("register_signed", args)
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(registry.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();
    assert_eq!(view("get_sponsor_status", json!({})).await?["used"], json!(1));

    Ok(())
}

#[tokio::test]
async fn byline_registry_end_to_end() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;
    run(wasm).await
}
