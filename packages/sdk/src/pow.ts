/**
 * Proof-of-work for gasless onboarding. The relayer asks each new registration for a small hash
 * puzzle bound to its signature: cheap for one agent (about a second), costly for someone farming
 * hundreds of free accounts. It rides next to the signed message, not inside it, so the registry
 * contract doesn't need to know about it.
 *
 * Valid when sha256("byline-pow:" || signature bytes || utf8(pow)) starts with `bits` zero bits.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** What the hosted relayer asks for unless it says otherwise (HTTP 428 with `pow_bits`). */
export const DEFAULT_POW_BITS = 20;

const PREFIX = new TextEncoder().encode("byline-pow:");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function leadingZeroBits(h: Uint8Array): number {
  let n = 0;
  for (const byte of h) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

function digest(sig: Uint8Array, pow: string): Uint8Array {
  const tail = new TextEncoder().encode(pow);
  const buf = new Uint8Array(PREFIX.length + sig.length + tail.length);
  buf.set(PREFIX, 0);
  buf.set(sig, PREFIX.length);
  buf.set(tail, PREFIX.length + sig.length);
  return sha256(buf);
}

/** True if `pow` solves the puzzle for this signature (base64) at `bits` difficulty. */
export function checkPow(signatureB64: string, pow: string, bits: number): boolean {
  if (bits <= 0) return true;
  if (typeof pow !== "string" || pow.length === 0 || pow.length > 32) return false;
  try {
    return leadingZeroBits(digest(fromB64(signatureB64), pow)) >= bits;
  } catch {
    return false;
  }
}

/** Find a `pow` for this signature (base64). About 2^bits hashes; yields to the event loop as it goes. */
export async function solvePow(signatureB64: string, bits: number = DEFAULT_POW_BITS): Promise<string> {
  if (bits <= 0) return "0";
  const sig = fromB64(signatureB64);
  for (let i = 0; ; i++) {
    const pow = i.toString(36);
    if (leadingZeroBits(digest(sig, pow)) >= bits) return pow;
    if (i % 50_000 === 49_999) await new Promise((r) => setTimeout(r, 0));
  }
}
