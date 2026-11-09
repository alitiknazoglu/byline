// Audits the Byline MCP server with mcprobe (lint + behavioural fuzz + 0-100 score).
//
//   npm run mcp:audit     prints the Markdown report. Fails on any critical behavioural issue,
//                         error handling below 10, or schema quality below 9. The overall score is
//                         reported but not gated: its latency part depends on the network.
//
// Safety, belt and braces: nothing in the audit can sign or spend.
// 1. This script re-runs itself with a near-empty environment (PATH, HOME, BYLINE_*).
// 2. The server's settings are passed explicitly through mcprobe's `env` (current mcprobe forwards
//    only a safe default environment plus that), pointing at a temp state dir and an EMPTY keys dir.
// 3. Before auditing, the script asks the server which keys it can see and refuses to run if any.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SERVER = fileURLToPath(new URL("../packages/mcp/dist/index.js", import.meta.url));

if (!process.env.BYLINE_AUDIT_CHILD) {
  const state = mkdtempSync(join(tmpdir(), "byline-audit-state-"));
  const keys = mkdtempSync(join(tmpdir(), "byline-audit-keys-"));
  writeFileSync(join(state, "agent-testnet.json"), JSON.stringify({ code: "nw5s2ea1", accountId: "nw5s2ea1.byline.testnet" }));
  // Only the RPC endpoint URLs come from .env (no keys): the server runs as configured in production.
  const rpc = {};
  try {
    const { readFileSync } = await import("node:fs");
    for (const line of readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8").split("\n")) {
      const m = /^(NEAR_RPC_(?:TESTNET|MAINNET))=(\S+)$/.exec(line.trim());
      if (m) rpc[m[1]] = m[2];
    }
  } catch {
    /* no .env: the public RPC is used */
  }
  const env = {
    ...rpc,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BYLINE_AUDIT_CHILD: "1",
    BYLINE_NETWORK: "testnet",
    BYLINE_STATE_DIR: state,
    BYLINE_KEYS_DIR: keys,
  };
  const r = spawnSync(process.execPath, [SELF, ...process.argv.slice(2)], { env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const serverEnv = {
  BYLINE_NETWORK: "testnet",
  BYLINE_STATE_DIR: process.env.BYLINE_STATE_DIR,
  BYLINE_KEYS_DIR: process.env.BYLINE_KEYS_DIR,
  // RPC endpoints only (no signing material): audit the server configured the way it runs in production.
  ...(process.env.NEAR_RPC_TESTNET ? { NEAR_RPC_TESTNET: process.env.NEAR_RPC_TESTNET } : {}),
  ...(process.env.NEAR_RPC_MAINNET ? { NEAR_RPC_MAINNET: process.env.NEAR_RPC_MAINNET } : {}),
};

// Refuse to audit if the server would see any key (the keys dir must be empty).
const { readdirSync } = await import("node:fs");
const visible = readdirSync(serverEnv.BYLINE_KEYS_DIR, { recursive: true }).filter((f) => String(f).endsWith(".json"));
if (visible.length) {
  console.error(`mcp-audit: refusing to run, the server could sign with: ${visible.join(", ")}`);
  process.exit(2);
}

const { auditStdio, renderReport } = await import("mcprobe/audit");
const report = await auditStdio(process.execPath, { args: [SERVER], fuzz: true, env: serverEnv });
console.log(renderReport(report));

const dim = (key) => report.dimensions.find((d) => d.key === key);
const errorHandling = dim("errorHandling")?.score;
const schema = dim("schemaQuality")?.score;
const critical = (report.fuzz ?? []).filter((r) => r.silentlyAccepted || r.outcome === "protocolCrash" || r.emptySuccess || r.outputSchemaViolation);
const problems = [];
if (critical.length) problems.push(`${critical.length} critical behavioural issue(s)`);
if (errorHandling !== undefined && errorHandling < 10) problems.push(`error handling ${errorHandling}/10`);
if (schema !== undefined && schema < 9) problems.push(`schema quality ${schema}/10`);
console.error(`\nmcprobe: ${report.overall}/100 (${report.grade}) · error handling ${errorHandling ?? "?"}/10 · schema ${schema ?? "?"}/10`);
console.error(
  "by category: " +
    report.dimensions.map((d) => `${d.key} ${d.score}/10${d.weight !== undefined ? ` (weight ${d.weight})` : ""}${d.notes ? ` [${d.notes}]` : ""}`).join(" · "),
);
if (problems.length) {
  console.error(`mcp-audit: FAILED (${problems.join("; ")})`);
  process.exit(1);
}
console.error("mcp-audit: passed (no critical issues, clean error handling, schema >= 9)");
