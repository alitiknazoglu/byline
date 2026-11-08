// Writes fixtures/nep413-register.json: register messages signed exactly the way the SDK signs them.
// The contract's unit tests verify these signatures and expected codes, which proves the TypeScript
// and Rust NEP-413 encodings agree. The keys are throwaway: only public keys and signatures are written.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generateKey } from "near-kit";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function codeFromSeed(seed) {
  const h = createHash("sha256").update(seed).digest();
  let bits = 0n;
  for (const b of h.subarray(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[Number((bits >> BigInt(35 - 5 * i)) & 31n)];
  return out;
}

const EXPIRES = 4102444800000; // 2100-01-01; unit tests run with the block time just before it
function sign(key, recipient, payload) {
  const message = JSON.stringify({ action: "register", expires_at_ms: EXPIRES, ...payload });
  const nonce = new Uint8Array(32).map((_, i) => i + 1);
  const signed = key.signNep413Message("agent", { message, recipient, nonce });
  const pk = key.publicKey.data;
  return {
    recipient,
    public_key: key.publicKey.toString(),
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    signature: signed.signature,
    expected_code: codeFromSeed(Buffer.concat([Buffer.from("byline:v2:"), Buffer.from(pk)])),
  };
}

const a = generateKey();
const b = generateKey();
const fixture = {
  note: "Signed by scripts/make-nep413-fixture.mjs with throwaway keys whose private halves were discarded.",
  expires_at_ms: EXPIRES,
  agent_a: sign(a, "byline.testnet", { title: "Fixture agent A" }),
  agent_a_with_payout: sign(a, "byline.testnet", { payout: "alice.near", fee_bps: 30 }),
  agent_b: sign(b, "byline.testnet", {}),
  wrong_recipient: sign(a, "someone-else.testnet", {}),
  wrong_action: (() => {
    const message = JSON.stringify({ action: "update", expires_at_ms: EXPIRES });
    const nonce = new Uint8Array(32).fill(9);
    return { public_key: a.publicKey.toString(), message, nonce: Buffer.from(nonce).toString("base64"), signature: a.signNep413Message("agent", { message, recipient: "byline.testnet", nonce }).signature };
  })(),
  tx_path_codes: {
    "alice.near:0": codeFromSeed("byline:v2:alice.near:0"),
    "alice.near:1": codeFromSeed("byline:v2:alice.near:1"),
  },
};
await writeFile(new URL("../fixtures/nep413-register.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("codes:", fixture.agent_a.expected_code, fixture.agent_b.expected_code, fixture.tx_path_codes);
