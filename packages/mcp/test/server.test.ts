/**
 * Drives the built server the way an agent's MCP client does: spawn over stdio, list tools, call them.
 * Reads live testnet + 1Click (dry). The only state is a temp dir naming the repo's demo agent,
 * and an empty keys dir, so nothing here can sign or spend.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CODE = "nw5s2ea1";
const AGENT = "nw5s2ea1.byline.testnet";
const MEMO_TX = "Aq3oHWpAJS57XARbRS8a2mta7kCxecUwHrM8RM3yE2h";
const FAILED_TX = "8J3PyP1m7gTN3a3iYUipTqp4rZCACvHviQe1BPDQFsA3"; // signed by the registry, refused

let client: Client;

type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Result>;

beforeAll(async () => {
  const state = await mkdtemp(join(tmpdir(), "byline-mcp-state-"));
  const keys = await mkdtemp(join(tmpdir(), "byline-mcp-keys-"));
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "agent-testnet.json"), JSON.stringify({ code: CODE, accountId: AGENT }));
  client = new Client({ name: "byline-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BYLINE_NETWORK: "testnet", BYLINE_STATE_DIR: state, BYLINE_KEYS_DIR: keys },
      stderr: "ignore",
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("byline MCP server", () => {
  it("advertises its flow and nine annotated tools; irreversible and spending tools are destructive", async () => {
    expect(client.getInstructions()).toMatch(/byline_create/);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ["byline_activity", "byline_create", "byline_info", "byline_link", "byline_pay", "byline_quote", "byline_register_with_wallet", "byline_swap", "byline_verify"].sort(),
    );
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      expect(t.outputSchema, t.name).toBeDefined();
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
    for (const n of ["byline_create", "byline_link", "byline_pay", "byline_swap", "byline_register_with_wallet"]) expect(byName[n]!.annotations!.destructiveHint, n).toBe(true);
    for (const n of ["byline_info", "byline_quote", "byline_activity", "byline_verify"]) expect(byName[n]!.annotations!.readOnlyHint, n).toBe(true);
  });

  it("byline_create returns the agent it already has instead of registering again", async () => {
    const r = await call("byline_create", { title: "ignored" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ code: CODE, account_id: AGENT, existing: true });
  });

  it("byline_info reads the registry and what quotes will carry", async () => {
    const r = await call("byline_info");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ code: CODE, owner: AGENT, account: AGENT, sponsored: true, referral: CODE, can_sign_here: false });
    expect(r.structuredContent!.warnings.join()).toMatch(/doesn't exist on NEAR mainnet/);
  }, 30_000);

  it("byline_quote is a real dry 1Click quote carrying the code", async () => {
    const r = await call("byline_quote", { amount: "1" });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ code: CODE, dry: true, referral: CODE });
    expect(BigInt(r.structuredContent!.amount_out)).toBeGreaterThan(0n);
  }, 30_000);

  it("byline_swap only previews without confirm (and on testnet at all)", async () => {
    const r = await call("byline_swap", { amount: "1", confirm: true });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ executed: false, dry: true, referral: CODE });
    expect(r.structuredContent!.why_not_executed).toMatch(/testnet/);
    expect(r.structuredContent!.why_not_executed).toMatch(/BYLINE_ALLOW_LIVE/);
  }, 30_000);

  it("byline_verify credits the agent's memo payment and not a failed registry tx", async () => {
    const yes = await call("byline_verify", { tx_hash: MEMO_TX });
    expect(yes.structuredContent).toMatchObject({ code: CODE, credited: true, signer: AGENT });
    expect(yes.structuredContent!.reasons.join(" ")).toMatch(/memo credits nw5s2ea1/);
    // The memo text itself comes back only in its own field, marked untrusted.
    expect(yes.structuredContent!.untrusted_memos).toContain("byline:nw5s2ea1 dca-fee");
    const no = await call("byline_verify", { tx_hash: FAILED_TX });
    expect(no.structuredContent).toMatchObject({ credited: false, signer: "byline.testnet" });
    // An unknown deposit address is an answer ("not credited"), not an error; each input is checked on its own.
    const both = await call("byline_verify", { tx_hash: MEMO_TX, deposit_address: "0".repeat(64) });
    expect(both.isError).toBeFalsy();
    expect(both.structuredContent).toMatchObject({ credited: false });
    expect(both.structuredContent!.reasons.join(" ")).toMatch(/1Click has no swap with this deposit address/);
  }, 30_000);

  it("byline_activity lists what the agent's own account signed", async () => {
    const r = await call("byline_activity", { limit: 5 });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.structuredContent!.accounts).toEqual([AGENT]);
    expect(r.structuredContent!.transactions.every((t: { signer: string }) => t.signer === AGENT)).toBe(true);
    expect(r.structuredContent!.memo_payments.map((m: { tx_hash: string }) => m.tx_hash)).toContain(MEMO_TX);
  }, 60_000);

  it("rejects bad input cleanly instead of crashing", async () => {
    for (const [name, args] of [
      ["byline_info", { code: "acme-trader" }],
      ["byline_quote", { amount: "1", surprise: true }],
      ["byline_quote", { amount: "-5" }],
      ["byline_pay", { token: "wrap.testnet", receiver_id: "NOT VALID", amount_raw: "1" }],
      ["byline_verify", {}],
    ] as const) {
      const r = await call(name, args as Record<string, unknown>);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  }, 30_000);

  it("refuses to pay without the agent's key on this machine", async () => {
    const r = await call("byline_pay", { token: "wrap.testnet", receiver_id: "byline.testnet", amount_raw: "1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/doesn't hold the key/);
  }, 30_000);
});

/**
 * Behavioural fuzz in the spirit of mcprobe: for every tool that doesn't spend funds, send the
 * mistakes a model makes on a bad day. Each must come back as a clean `isError` result: never
 * silently accepted, never a transport crash. Spending (destructive) tools are skipped, as mcprobe does.
 */
describe("fuzz: malformed calls are rejected cleanly", () => {
  it("missing_required / wrong_type / extra_garbage / out_of_range on every non-destructive tool", async () => {
    const { tools } = await client.listTools();
    const outcomes: string[] = [];
    for (const t of tools) {
      if (t.annotations?.destructiveHint) continue;
      const schema = t.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
      const props = Object.entries(schema.properties ?? {});
      const cases: [string, Record<string, unknown>][] = [["extra_garbage", { zz_unknown_field: "garbage" }]];
      const firstString = props.find(([, p]) => p.type === "string");
      if (firstString) cases.push(["wrong_type", { [firstString[0]]: 12345 }]);
      const firstNumber = props.find(([, p]) => p.type === "number" || p.type === "integer");
      if (firstNumber) cases.push(["out_of_range", { [firstNumber[0]]: 1e12 }]);
      if (schema.required?.length) cases.push(["missing_required", {}]);
      for (const [kind, args] of cases) {
        let verdict: string;
        try {
          const r = await call(t.name, args);
          verdict = r.isError ? "rejected" : "SILENTLY ACCEPTED";
        } catch (e) {
          verdict = `PROTOCOL ERROR: ${(e as Error).message}`;
        }
        outcomes.push(`${t.name} ${kind}: ${verdict}`);
      }
    }
    expect(outcomes.length).toBeGreaterThanOrEqual(10); // 4 read-only tools × 2-3 malformed cases each
    expect(outcomes.filter((o) => !o.endsWith("rejected"))).toEqual([]);
  }, 120_000);
});
