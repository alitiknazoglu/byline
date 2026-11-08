import { Near } from "near-kit";
import { assertValidCode, MAX_FEE_BPS } from "./names.js";
import type { Registry } from "./registry.js";
import { nearConfig, type AppFee, type Attribution } from "./types.js";

/** 64 lowercase hex chars: a NEAR implicit account, which exists as soon as it holds funds. */
const IMPLICIT = /^[0-9a-f]{64}$/;

export interface PayoutChecker {
  /** True if `accountId` can receive fees where 1Click settles them (NEAR mainnet). */
  canReceive(accountId: string): Promise<boolean>;
}

/**
 * Checks payouts on NEAR mainnet, where 1Click settles app fees.
 * 1Click accepts any account name, so a fee sent to a missing account is lost
 * (or claimable by whoever registers that name later). The SDK refuses to route fees there.
 */
export function mainnetPayoutChecker(near: Near = new Near(nearConfig("mainnet"))): PayoutChecker {
  const cache = new Map<string, boolean>();
  return {
    async canReceive(accountId) {
      if (IMPLICIT.test(accountId)) return true;
      if (accountId.endsWith(".testnet")) return false;
      const hit = cache.get(accountId);
      if (hit !== undefined) return hit;
      const ok = await near.accountExists(accountId);
      cache.set(accountId, ok);
      return ok;
    },
  };
}

/**
 * Read a byline's attribution from the registry and check it is safe to attach.
 * Throws if the byline doesn't exist. Drops `appFees` (keeping the referral) when the payout
 * can't receive fees, and says why in `warnings`.
 */
export async function resolveAttribution(
  registry: Registry,
  code: string,
  checker: PayoutChecker = mainnetPayoutChecker(),
): Promise<Attribution> {
  assertValidCode(code);
  const raw = await registry.getAttribution(code);
  if (!raw) throw new Error(`No byline "${code}" in ${registry.contractId}`);

  const warnings: string[] = [];
  const appFees: AppFee[] = [];
  for (const fee of raw.app_fees) {
    if (fee.fee > MAX_FEE_BPS) {
      warnings.push(`fee ${fee.fee} bps is above the ${MAX_FEE_BPS} bps cap; fee not attached`);
    } else if (!(await checker.canReceive(fee.recipient))) {
      warnings.push(
        `payout ${fee.recipient} doesn't exist on NEAR mainnet, where 1Click pays fees; ` +
          `fee not attached (the swap is still credited through the referral)`,
      );
    } else {
      appFees.push({ recipient: fee.recipient, fee: fee.fee });
    }
  }
  return { code, referral: raw.referral, appFees, warnings };
}

/**
 * Add a byline's `referral` and `appFees` to a 1Click quote request.
 * Fees the request already carries (e.g. the app's own) are kept, and the byline's are appended.
 */
export function withByline<T extends { referral?: string; appFees?: AppFee[] }>(
  request: T,
  attribution: Pick<Attribution, "referral" | "appFees">,
): T & { referral: string; appFees?: AppFee[] } {
  if (request.referral && request.referral !== attribution.referral) {
    throw new Error(
      `Quote already has referral "${request.referral}"; a quote can carry only one byline`,
    );
  }
  const appFees = [...(request.appFees ?? []), ...attribution.appFees];
  const out = { ...request, referral: attribution.referral } as T & { referral: string; appFees?: AppFee[] };
  if (appFees.length) out.appFees = appFees;
  else delete out.appFees;
  return out;
}
