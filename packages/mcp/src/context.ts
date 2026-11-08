/** Server configuration (from env) and the agent the server acts as. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Byline, mainnetPayoutChecker, OneClick, RELAYER_URLS, REGISTRY_IDS, Registry, type BylineRecord, type NetworkId, type Recorder } from "@by-line/sdk";
import { jsonlRecorder, nearFromCredentials } from "@by-line/sdk/node";
import { FastNear } from "@by-line/indexer/chain";

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
  /** Largest live swap, in human units of the `from` token (BYLINE_MAX_SWAP, default 10). */
  maxSwap: number;
  /** Largest payment in the token's smallest unit (BYLINE_MAX_PAY_RAW). Unset: no cap beyond the account's balance. */
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
    maxSwap: positiveNumber("BYLINE_MAX_SWAP", env.BYLINE_MAX_SWAP, 10),
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

  signerFor(accountId: string) {
    if (!this.hasKey(accountId)) throw new Error(`No key for ${accountId} in ${join(this.config.keysDir, this.config.network)}`);
    return nearFromCredentials(accountId, this.config.network, this.config.keysDir);
  }
}
