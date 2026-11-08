/** Live: a full sync of byline.testnet into a temporary database (FastNear, testnet RPC, 1Click, mainnet RPC). Read-only. */
import { describe, expect, it } from "vitest";
import { createContext, leaderboard, openDb, syncAll } from "../src/index.js";

describe("live testnet sync", () => {
  it("credits the gasless demo agent's real transactions and memo payment", async () => {
    const db = openDb(":memory:");
    await syncAll(db, createContext({ network: "testnet" }));
    // The repo's demo agent, onboarded gaslessly (see apps/agent).
    const demo = leaderboard(db, "testnet").find((r) => r.name === "nw5s2ea1");
    expect(demo).toBeDefined();
    expect(demo!.account).toBe("nw5s2ea1.byline.testnet");
    expect(demo!.txs).toBeGreaterThanOrEqual(2);
    expect(demo!.memo_transfers).toBeGreaterThanOrEqual(1);
    expect(demo!.sample).toBe(false);
    const events = db.prepare("SELECT event FROM registry_events WHERE name = 'nw5s2ea1'").all() as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["byline_registered", "account_created", "account_linked"]));
  }, 120_000);
});
