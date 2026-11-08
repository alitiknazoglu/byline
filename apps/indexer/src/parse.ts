/** Pure functions that turn FastNear transactions into rows. No I/O, so they are unit-tested directly. */
import { parseBylineMemo } from "@bylinecode/sdk";
import type { FastAction, FastTransaction } from "./fastnear.js";

export interface ParsedTx {
  hash: string;
  signer: string;
  receiver: string;
  methods: string[];
  depositYocto: string;
  success: boolean;
  blockHeight: number;
  blockTsMs: number;
}

export interface ParsedMemoTransfer {
  txHash: string;
  actionIndex: number;
  name: string;
  token: string;
  sender: string;
  receiver: string;
  amount: string;
  memo: string;
  success: boolean;
  blockTsMs: number;
}

export interface ParsedEvent {
  txHash: string;
  receiptId: string;
  logIndex: number;
  standard: string;
  event: string;
  name: string | null;
  data: unknown;
  blockTsMs: number;
}

const nsToMs = (ns: number | string): number => Math.floor(Number(ns) / 1e6);

export function decodeArgs(b64: string): Record<string, unknown> | null {
  try {
    // atob + TextDecoder instead of Buffer, so this also runs in the browser (the web app's `verify`).
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isFailure(status: Record<string, unknown>): boolean {
  return "Failure" in status;
}

/** True if no receipt of the transaction failed. */
export function txSucceeded(t: FastTransaction): boolean {
  if (isFailure(t.execution_outcome.outcome.status)) return false;
  return !t.receipts.some((r) => isFailure(r.execution_outcome.outcome.status));
}

function actionsOf(t: FastTransaction): FastAction[] {
  return t.transaction.actions.map((a) => (typeof a === "string" ? { [a]: {} } : a));
}

export function parseTx(t: FastTransaction): ParsedTx {
  const actions = actionsOf(t);
  let deposit = 0n;
  const methods: string[] = [];
  for (const a of actions) {
    if (a.FunctionCall) {
      methods.push(a.FunctionCall.method_name);
      deposit += BigInt(a.FunctionCall.deposit ?? "0");
    } else if (a.Transfer) {
      methods.push("transfer");
      deposit += BigInt(a.Transfer.deposit ?? "0");
    } else {
      methods.push(Object.keys(a)[0]!.replace(/^./, (c) => c.toLowerCase()));
    }
  }
  return {
    hash: t.transaction.hash,
    signer: t.transaction.signer_id,
    receiver: t.transaction.receiver_id,
    methods,
    depositYocto: deposit.toString(),
    success: txSucceeded(t),
    blockHeight: t.execution_outcome.block_height,
    blockTsMs: nsToMs(t.execution_outcome.block_timestamp),
  };
}

/**
 * NEP-141 transfers in this transaction whose memo credits a byline.
 * Read from the signed actions themselves (`ft_transfer` / `ft_transfer_call` args), so the
 * memo is exactly what the signer authorised. Success is the token receipt's status.
 */
export function parseMemoTransfers(t: FastTransaction): ParsedMemoTransfer[] {
  const out: ParsedMemoTransfer[] = [];
  const tokenReceipt = t.receipts.find(
    (r) => r.execution_outcome.outcome.executor_id === t.transaction.receiver_id && r.receipt.predecessor_id === t.transaction.signer_id,
  );
  const success = tokenReceipt ? !isFailure(tokenReceipt.execution_outcome.outcome.status) : txSucceeded(t);
  actionsOf(t).forEach((a, i) => {
    const fc = a.FunctionCall;
    if (!fc || (fc.method_name !== "ft_transfer" && fc.method_name !== "ft_transfer_call")) return;
    const args = decodeArgs(fc.args);
    const memo = typeof args?.memo === "string" ? args.memo : null;
    const name = parseBylineMemo(memo);
    if (!name || !args) return;
    out.push({
      txHash: t.transaction.hash,
      actionIndex: i,
      name,
      token: t.transaction.receiver_id,
      sender: t.transaction.signer_id,
      receiver: String(args.receiver_id ?? ""),
      amount: String(args.amount ?? "0"),
      memo: memo!,
      success,
      blockTsMs: nsToMs(t.execution_outcome.block_timestamp),
    });
  });
  return out;
}

/** NEP-297 events logged by `contractId` (the registry): `standard` "byline" and "nep171". */
export function parseRegistryEvents(t: FastTransaction, contractId: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const r of t.receipts) {
    const o = r.execution_outcome;
    if (o.outcome.executor_id !== contractId || isFailure(o.outcome.status)) continue;
    o.outcome.logs.forEach((log, logIndex) => {
      if (!log.startsWith("EVENT_JSON:")) return;
      let ev: { standard?: string; version?: string; event?: string; data?: unknown };
      try {
        ev = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        return;
      }
      if (!ev.standard || !ev.event) return;
      if (ev.standard !== "byline" && ev.standard !== "nep171") return;
      // v1 of the registry used chosen names; those bylines were retired when testnet moved to codes.
      if (ev.standard === "byline" && ev.version === "1.0.0") return;
      out.push({
        txHash: t.transaction.hash,
        receiptId: o.id,
        logIndex,
        standard: ev.standard,
        event: ev.event,
        name: eventName(ev.data),
        data: ev.data ?? null,
        blockTsMs: nsToMs(o.block_timestamp),
      });
    });
  }
  return out;
}

function eventName(data: unknown): string | null {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (typeof o.code === "string") return o.code;
  if (typeof o.name === "string") return o.name;
  if (Array.isArray(o.token_ids) && typeof o.token_ids[0] === "string") return o.token_ids[0];
  return null;
}

/** USD value of a swap's fee share for the builder. */
export function builderFeeUsd(amountInUsd: number | null | undefined, builderFeeBps: number): number {
  return amountInUsd ? (amountInUsd * builderFeeBps) / 10_000 : 0;
}
