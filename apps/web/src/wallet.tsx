import type { NearConnector } from "@hot-labs/near-connect";
import { Near, fromNearConnect } from "near-kit";
import { NETWORK } from "./network";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** The wallet connects on the network this build serves (testnet.by-line.xyz or www.by-line.xyz). */
export const WALLET_NETWORK = NETWORK;

export interface WalletState {
  accountId: string | null;
  connecting: boolean;
  error: string | null;
  /** Resolves to the connected account, or null if the user backed out. */
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** A near-kit client that signs through the connected wallet. */
  near: Near | null;
}

const Ctx = createContext<WalletState | null>(null);

/** The wallet library loads on its own, after the page: most visitors never connect. */
let connector: Promise<NearConnector> | null = null;
function getConnector(): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network: WALLET_NETWORK, footerBranding: null }));
  return connector;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [conn, setConn] = useState<NearConnector | null>(null);

  useEffect(() => {
    let c: NearConnector | null = null;
    const onIn = (e: { accounts: { accountId: string }[] }) => setAccountId(e.accounts[0]?.accountId ?? null);
    const onOut = () => setAccountId(null);
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(cb) : setTimeout(cb, 300));
    idle(() => {
      void getConnector().then((x) => {
        c = x;
        setConn(x);
        x.on("wallet:signIn", onIn as never);
        x.on("wallet:signOut", onOut as never);
        x.wallet()
          .then((w) => w.getAccounts())
          .then((a) => setAccountId(a[0]?.accountId ?? null))
          .catch(() => {});
      });
    });
    return () => {
      c?.off("wallet:signIn", onIn as never);
      c?.off("wallet:signOut", onOut as never);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const w = await (await getConnector()).connect();
      const a = await w.getAccounts();
      const id = a[0]?.accountId ?? null;
      setAccountId(id);
      return id;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!/reject|cancel|closed/i.test(msg)) setError(`The wallet didn't connect: ${msg}`);
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await (await getConnector()).disconnect().catch(() => {});
    setAccountId(null);
  }, []);

  const near = useMemo(
    () => (accountId && conn ? new Near({ network: WALLET_NETWORK, wallet: fromNearConnect(conn as never), defaultSignerId: accountId }) : null),
    [accountId, conn],
  );

  return <Ctx.Provider value={{ accountId, connecting, error, connect, disconnect, near }}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
