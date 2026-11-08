import type { AppFee } from "./types.js";

export const ONECLICK_API = "https://1click.chaindefuser.com/v0";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";

/** The 1Click `/quote` request. Only the fields the SDK touches are typed strictly. */
export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  deadline: string;
  referral?: string;
  appFees?: AppFee[];
  quoteWaitingTimeMs?: number;
  [extra: string]: unknown;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut?: string;
  deadline?: string;
  timeEstimate?: number;
}

export interface QuoteResponse {
  correlationId?: string;
  timestamp?: string;
  signature?: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export const TERMINAL_STATUSES: SwapStatus[] = ["SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"];

export interface StatusResponse {
  status: SwapStatus;
  updatedAt?: string;
  quoteResponse?: QuoteResponse;
  swapDetails?: Record<string, unknown>;
}

export class OneClickError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    path: string,
  ) {
    const msg = typeof body === "object" && body && "message" in body ? String(body.message) : JSON.stringify(body);
    super(`1Click ${path} → ${status}: ${msg}`);
  }
}

export interface OneClickOptions {
  /** Partner JWT from partners.near-intents.org. Without it 1Click adds its own 25 bps. */
  jwt?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Minimal 1Click API client (NEAR Intents). */
export class OneClick {
  private readonly baseUrl: string;
  private readonly jwt?: string;
  private readonly fetchImpl: typeof fetch;
  private tokensCache?: Promise<OneClickToken[]>;

  constructor(opts: OneClickOptions = {}) {
    this.baseUrl = opts.baseUrl ?? ONECLICK_API;
    this.jwt = opts.jwt;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  tokens(): Promise<OneClickToken[]> {
    this.tokensCache ??= this.request<OneClickToken[]>("GET", "/tokens").catch((e) => {
      this.tokensCache = undefined;
      throw e;
    });
    return this.tokensCache;
  }

  /** Find a token by assetId, or by `symbol` on `blockchain` (default "near"). */
  async token(query: string, blockchain = "near"): Promise<OneClickToken> {
    const all = await this.tokens();
    const q = query.toLowerCase();
    const hit =
      all.find((t) => t.assetId === query) ??
      all.find((t) => t.blockchain === blockchain && t.symbol.toLowerCase() === q);
    if (!hit) throw new Error(`1Click has no token "${query}" on ${blockchain}`);
    return hit;
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/quote", request);
  }

  submitDeposit(args: { txHash: string; depositAddress: string; nearSenderAccount?: string }): Promise<unknown> {
    return this.request("POST", "/deposit/submit", args);
  }

  status(depositAddress: string): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", `/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }

  /** Poll `status` until it reaches a terminal state or `timeoutMs` passes. */
  async waitForStatus(
    depositAddress: string,
    { timeoutMs = 5 * 60_000, intervalMs = 3_000, onUpdate }: { timeoutMs?: number; intervalMs?: number; onUpdate?: (s: StatusResponse) => void } = {},
  ): Promise<StatusResponse> {
    const end = Date.now() + timeoutMs;
    let last: StatusResponse | undefined;
    while (Date.now() < end) {
      const s = await this.status(depositAddress);
      if (s.status !== last?.status) onUpdate?.(s);
      last = s;
      if (TERMINAL_STATUSES.includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for ${depositAddress}; last status ${last?.status ?? "unknown"}`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) throw new OneClickError(res.status, parsed, path);
    return parsed as T;
  }
}
