import { Near, type CallOptions } from "near-kit";
import type { SignedRegistration } from "./onboard.js";
import { nearConfig, REGISTRY_IDS, type BylineRecord, type NetworkId, type RegistryAttribution, type SponsorStatus } from "./types.js";

type Gas = NonNullable<CallOptions["gas"]>;
type Deposit = NonNullable<CallOptions["attachedDeposit"]>;

/**
 * Lean gas for calls an agent's own (small) account makes. A function call reserves its prepaid gas
 * at a pessimistic price (~0.0066 NEAR per 10 Tgas) until it settles, so less gas means a sponsored
 * account with 0.03 NEAR can keep acting.
 */
const GAS_SMALL: Gas = "10 Tgas";
const GAS_REGISTER: Gas = "30 Tgas";
const GAS_ACCOUNT: Gas = "100 Tgas";
/**
 * register_signed: a real mainnet registration burned about 15 Tgas in all, and its callback is given 15 Tgas.
 * The relayer's key pays for prepaid gas out of its allowance (unused gas isn't credited back to it), so
 * attach what's needed with headroom, not 100 Tgas.
 */
const GAS_REGISTER_SIGNED: Gas = "50 Tgas";
/** Attached to storage-paying calls. The contract keeps only the storage cost and refunds the rest. */
const STORAGE_DEPOSIT: Deposit = "0.01 NEAR";
/** Owner-only and unlink calls require exactly 1 yoctoNEAR, which forces a full-access key. */
const ONE_YOCTO: Deposit = "1 yocto";

export interface RegistryOptions {
  network: NetworkId;
  /** Defaults to `byline.near` / `byline.testnet`. */
  contractId?: string;
  /** A near-kit instance. Read-only is fine for views; calls need a signer. */
  near?: Near;
  /** The account that signs calls (defaults to the near-kit default signer). */
  signerId?: string;
}

export interface RegisterArgs {
  payout?: string;
  fee_bps?: number;
  title?: string;
  description?: string;
}

export interface UpdateArgs extends RegisterArgs {
  code: string;
}

/**
 * Typed client for the registry contract (contract/RULES.md).
 * Views work without keys. Change methods sign with the near-kit instance you pass in.
 */
export class Registry {
  readonly network: NetworkId;
  readonly contractId: string;
  readonly near: Near;
  private readonly signerId?: string;

  constructor(opts: RegistryOptions) {
    this.network = opts.network;
    this.contractId = opts.contractId ?? REGISTRY_IDS[opts.network];
    this.near = opts.near ?? new Near(nearConfig(opts.network));
    this.signerId = opts.signerId;
  }

  /** `<code>.<registry>`. */
  agentAccountId(code: string): string {
    return `${code}.${this.contractId}`;
  }

  // ---------- views ----------

  async getByline(code: string): Promise<BylineRecord | null> {
    return (await this.near.view<BylineRecord | null>(this.contractId, "get_byline", { code })) ?? null;
  }

  async getBylines(fromIndex = 0, limit = 50): Promise<BylineRecord[]> {
    return (
      (await this.near.view<BylineRecord[]>(this.contractId, "get_bylines", { from_index: String(fromIndex), limit })) ?? []
    );
  }

  async getBylinesForOwner(ownerId: string, fromIndex = 0, limit = 50): Promise<BylineRecord[]> {
    return (
      (await this.near.view<BylineRecord[]>(this.contractId, "get_bylines_for_owner", {
        owner_id: ownerId,
        from_index: String(fromIndex),
        limit,
      })) ?? []
    );
  }

  /** The byline `accountId` acts for (its own account or a linked one), or null. */
  async getBylineForAccount(accountId: string): Promise<string | null> {
    return (await this.near.view<string | null>(this.contractId, "get_byline_for_account", { account_id: accountId })) ?? null;
  }

  /** The byline a key onboarded gaslessly, or null. */
  async getBylineForKey(publicKey: string): Promise<string | null> {
    return (await this.near.view<string | null>(this.contractId, "get_byline_for_key", { public_key: publicKey })) ?? null;
  }

  async getAttribution(code: string): Promise<RegistryAttribution | null> {
    return (await this.near.view<RegistryAttribution | null>(this.contractId, "get_attribution", { code })) ?? null;
  }

  async getSponsorStatus(): Promise<SponsorStatus> {
    const s = await this.near.view<{ used: number; limit: number; seed: string }>(this.contractId, "get_sponsor_status", {});
    return s ?? { used: 0, limit: 0, seed: "0" };
  }

  // ---------- calls (signed) ----------

  /**
   * Register a byline from a funded account (a human's wallet, or an agent holding one).
   * The registry generates the code. Storage comes out of the attached 0.01 NEAR; the rest is refunded.
   */
  async register(args: RegisterArgs = {}): Promise<BylineRecord> {
    return this.call<BylineRecord>("register", args, STORAGE_DEPOSIT, GAS_REGISTER);
  }

  /** Change payout, fee or text. Builder only, signed with a full-access key. */
  async update(args: UpdateArgs): Promise<BylineRecord> {
    return this.call<BylineRecord>("update", args, STORAGE_DEPOSIT, GAS_SMALL);
  }

  /**
   * Create the agent's own account `<code>.<registry>` with `publicKey` as its full-access key.
   * `deposit` funds the new account (at least 0.01 NEAR; the registry keeps 0.002 NEAR).
   */
  async createAccount(code: string, publicKey: string, deposit: Deposit = "0.05 NEAR"): Promise<boolean> {
    return this.call<boolean>("create_account", { code, public_key: publicKey }, deposit, GAS_ACCOUNT);
  }

  /** Builder invites an existing account. The account then calls `linkAccount` itself. */
  async inviteAccount(code: string, accountId: string): Promise<void> {
    await this.call("invite_account", { code, account_id: accountId }, STORAGE_DEPOSIT, GAS_SMALL);
  }

  /** Signed by the invited account: links it to the byline. */
  async linkAccount(code: string): Promise<void> {
    await this.call("link_account", { code }, STORAGE_DEPOSIT, GAS_SMALL);
  }

  /** Signed by the linked account or by the builder. */
  async unlinkAccount(accountId: string): Promise<void> {
    await this.call("unlink_account", { account_id: accountId }, ONE_YOCTO, GAS_SMALL);
  }

  /** Builder withdraws an invite that wasn't accepted. The invite's storage comes back. */
  async cancelInvite(code: string, accountId: string): Promise<void> {
    await this.call("cancel_invite", { code, account_id: accountId }, ONE_YOCTO, GAS_SMALL);
  }

  /**
   * Relayer only: submit an agent's signed registration. The signer must be a key on the registry
   * account itself (a function-call key limited to `register_signed`). Returns the transaction hash.
   */
  async registerSigned(reg: SignedRegistration): Promise<string> {
    const outcome = await this.near
      .transaction(this.signerId ?? this.contractId)
      .functionCall(this.contractId, "register_signed", reg, { gas: GAS_REGISTER_SIGNED })
      .send({ waitUntil: "FINAL" });
    const o = outcome as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } };
    return o.transaction_outcome?.id ?? o.transaction?.hash ?? "";
  }

  /** Registry owner only. */
  async setSponsorLimit(limit: number): Promise<void> {
    await this.call("set_sponsor_limit", { limit }, ONE_YOCTO, GAS_SMALL);
  }

  private async call<T>(method: string, args: object, attachedDeposit?: Deposit, gas: Gas = GAS_SMALL): Promise<T> {
    return this.near.call<T>(this.contractId, method, args, {
      gas,
      ...(attachedDeposit ? { attachedDeposit } : {}),
      ...(this.signerId ? { signerId: this.signerId } : {}),
    });
  }
}
