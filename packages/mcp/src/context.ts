/** Server configuration (from env) and the agent the server acts as. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Byline, mainnetPayoutChecker, OneClick, resolveAttribution, RELAYER_URLS, REGISTRY_IDS, Registry, type BylineRecord, type NetworkId, type Recorder } from "@by-line/sdk";
import { jsonlRecorder, nearFromCredentials } from "@by-line/sdk/node";
import { FastNear } from "@by-line/sdk/chain";

export interface Config {
  network: NetworkId;
  registryId: string;
  relayerUrl: string;
  /** near-cli layout: `<keysDir>/<network>/<account>.json`. */
  keysDir: string;
  /** Where the server remembers its agent between runs. */
  stateDir: string;
  /** Mainnet swaps and payments move real funds; they need BYLINE_ALLOW_LIVE=1 as well as confirm:true. */
  allowLive: boolean;
  /** Optional JSONL log the indexer reads (same format as the SDK recorder). */
  recordPath?: string;
  /** Largest live swap in US dollars, checked against 1Click's quote right before the deposit (BYLINE_MAX_SWAP_USD, default 10). */
  maxSwapUsd: number;
  /** Total live swaps this process may make, in US dollars (BYLINE_MAX_SPEND_USD, default 50). */
  maxSpendUsd: number;
  /** Live swaps may send their output to accounts other than the agent's own (BYLINE_ALLOW_EXTERNAL_RECIPIENT=1). */
  allowExternalRecipient: boolean;
  /** Largest payment in human units of the token, e.g. "5" (BYLINE_MAX_PAY). Decimals are read from the token. */
  maxPay?: string;
  /** Largest payment in the token's smallest unit (BYLINE_MAX_PAY_RAW). On mainnet one of the two caps is required. */
  maxPayRaw?: bigint;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (env.BYLINE_NETWORK ?? "testnet") as NetworkId;
  if (network !== "testnet" && network !== "mainnet") throw new Error(`BYLINE_NETWORK must be testnet or mainnet, got ${network}`);
  return {
    network,
    registryId: env.BYLINE_REGISTRY || REGISTRY_IDS[network],
    relayerUrl: env.BYLINE_RELAYER_URL || RELAYER_URLS[network],
    keysDir: env.BYLINE_KEYS_DIR || join(homedir(), ".near-credentials"),
    stateDir: env.BYLINE_STATE_DIR || join(homedir(), ".byline"),
    allowLive: env.BYLINE_ALLOW_LIVE === "1",
    recordPath: env.BYLINE_RECORD || undefined,
    maxSwapUsd: positiveNumber("BYLINE_MAX_SWAP_USD", env.BYLINE_MAX_SWAP_USD, 10),
    maxSpendUsd: positiveNumber("BYLINE_MAX_SPEND_USD", env.BYLINE_MAX_SPEND_USD, 50),
    allowExternalRecipient: env.BYLINE_ALLOW_EXTERNAL_RECIPIENT === "1",
    maxPay: env.BYLINE_MAX_PAY
      ? /^\d{1,18}(\.\d{1,24})?$/.test(env.BYLINE_MAX_PAY)
        ? env.BYLINE_MAX_PAY
        : (() => {
            throw new Error(`BYLINE_MAX_PAY must be a positive decimal like "5", got ${env.BYLINE_MAX_PAY}`);
          })()
      : undefined,
    maxPayRaw: env.BYLINE_MAX_PAY_RAW ? (/^[1-9]\d*$/.test(env.BYLINE_MAX_PAY_RAW) ? BigInt(env.BYLINE_MAX_PAY_RAW) : (() => {
      throw new Error(`BYLINE_MAX_PAY_RAW must be a positive integer, got ${env.BYLINE_MAX_PAY_RAW}`);
    })()) : undefined,
  };
}

export interface AgentState {
  code: string;
  accountId: string;
  keyFile?: string;
}

export class Context {
  readonly registry: Registry;
  readonly fastnear = new FastNear();
  /** Shared across calls: 1Click's token list and mainnet payout checks are cached inside them. */
  readonly oneClick = new OneClick();
  private readonly payoutChecker = mainnetPayoutChecker();
  private readonly recorder?: Recorder;
  private readonly records = new Map<string, { at: number; record: BylineRecord }>();
  private readonly bylines = new Map<string, { byline: Byline; accountId: string; canSign: boolean }>();
  private static readonly RECORD_TTL_MS = 60_000;
  /** US dollars of live swaps this process has sent (against BYLINE_MAX_SPEND_USD). */
  spentUsd = 0;

  constructor(readonly config: Config) {
    this.registry = new Registry({ network: config.network, contractId: config.registryId });
    this.recorder = config.recordPath ? jsonlRecorder(config.recordPath) : undefined;
  }

  get explorer(): string {
    return this.config.network === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";
  }

  private get statePath(): string {
    return join(this.config.stateDir, `agent-${this.config.network}.json`);
  }

  async agent(): Promise<AgentState | null> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as AgentState;
    } catch {
      return null;
    }
  }

  async saveAgent(a: AgentState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  }

  /** The code a tool acts on: the explicit one, else this server's agent. */
  async resolveCode(code?: string): Promise<string> {
    if (code) return code;
    const a = await this.agent();
    if (!a) throw new Error("No byline yet. Call byline_create first (or pass `code`).");
    return a.code;
  }

  keyFileFor(accountId: string): string {
    return join(this.config.keysDir, this.config.network, `${accountId}.json`);
  }

  hasKey(accountId: string): boolean {
    return existsSync(this.keyFileFor(accountId));
  }

  /** The registry's record for `code`, cached for a minute (changes are rare and callers re-read on demand). */
  async record(code: string, fresh = false): Promise<BylineRecord> {
    const hit = this.records.get(code);
    if (!fresh && hit && Date.now() - hit.at < Context.RECORD_TTL_MS) return hit.record;
    const record = await this.registry.getByline(code);
    if (!record) throw new Error(`No byline "${code}" in ${this.config.registryId}`);
    this.records.set(code, { at: Date.now(), record });
    return record;
  }

  /**
   * A Byline client for `code`, signing as the byline's own agent account (`<code>.<registry>`) when this
   * machine holds its key. Never as the owner: a byline registered from a wallet has no agent account, and
   * the owner's wallet (whose key may sit in the same keys directory) must not be spendable by a tool call.
   */
  async byline(code: string): Promise<{ byline: Byline; accountId: string; canSign: boolean }> {
    const record = await this.record(code);
    const accountId = record.account ?? record.owner;
    const canSign = record.account !== null && record.account !== undefined && this.hasKey(record.account);
    const cached = this.bylines.get(code);
    if (cached && cached.accountId === accountId && cached.canSign === canSign) return cached;
    const byline = new Byline({
      code,
      network: this.config.network,
      registryId: this.config.registryId,
      accountId,
      ...(canSign ? { near: nearFromCredentials(accountId, this.config.network, this.config.keysDir) } : {}),
      oneClick: this.oneClick,
      payoutChecker: this.payoutChecker,
      ...(this.recorder ? { recorder: this.recorder } : {}),
    });
    const entry = { byline, accountId, canSign };
    this.bylines.set(code, entry);
    return entry;
  }

  private readonly quoters = new Map<string, Byline>();

  /**
   * A read-only Byline for dry quotes: no record lookup first (the quote needs only the attribution and
   * 1Click's token list), so nothing waits on an extra registry read. Never signs.
   */
  quoter(code: string): Byline {
    let b = this.quoters.get(code);
    if (!b) {
      b = new Byline({
        code,
        network: this.config.network,
        registryId: this.config.registryId,
        oneClick: this.oneClick,
        payoutChecker: this.payoutChecker,
        ...(this.recorder ? { recorder: this.recorder } : {}),
      });
      this.quoters.set(code, b);
    }
    return b;
  }

  /** What quotes for `code` will carry (referral, appFees, warnings), with the shared mainnet payout checker. */
  attribution(code: string) {
    return resolveAttribution(this.registry, code, this.payoutChecker);
  }

  /**
   * Start the reads every session needs anyway, so the first call doesn't wait for them: 1Click's token
   * list, and this server's own agent's record and attribution (what its quotes carry). Failures are
   * ignored; the first real call just fetches what it needs itself.
   */
  warmUp(): void {
    const quiet = () => {};
    void this.oneClick.tokens().catch(quiet);
    void this.agent()
      .then((a) => {
        if (!a) return;
        void this.record(a.code).catch(quiet);
        void this.quoter(a.code).attribution().catch(quiet);
      })
      .catch(quiet);
  }

  signerFor(accountId: string) {
    if (!this.hasKey(accountId)) throw new Error(`No key for ${accountId} in ${join(this.config.keysDir, this.config.network)}`);
    return nearFromCredentials(accountId, this.config.network, this.config.keysDir);
  }
}
