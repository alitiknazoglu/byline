#!/usr/bin/env node
/**
 * byline-mcp: an MCP server that lets AI agents use Byline on NEAR.
 *
 * Speaks JSON-RPC on stdin/stdout; every log line goes to stderr so it never corrupts the transport.
 * Configure with env: BYLINE_NETWORK (testnet), BYLINE_RELAYER_URL, BYLINE_KEYS_DIR, BYLINE_STATE_DIR,
 * BYLINE_RECORD, BYLINE_ALLOW_LIVE=1 (mainnet swaps and payments).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Context, loadConfig } from "./context.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `Byline gives this agent an on-chain identity on NEAR: a random code (e.g. "k7m2x9qa") that credits its swaps, payments and transactions to it and to its builder.
Flow: 1) byline_info (do I have a byline?) → if not, byline_create (free, no funds needed; the registry pays). 2) byline_quote to get a credited swap quote (always dry). 3) byline_pay for a payment carrying memo byline:<code>. 4) byline_activity / byline_verify to check what was credited.
Safety: quotes never move funds. byline_swap only previews unless confirm=true on mainnet with BYLINE_ALLOW_LIVE=1. Never ask the user for private keys; keys stay in the keys directory on this machine.`;

async function main() {
  const config = loadConfig();
  const ctx = new Context(config);
  const server = new McpServer({ name: "byline", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  await server.connect(new StdioServerTransport());
  console.error(`[byline-mcp] ready on stdio · ${config.network} · registry ${config.registryId}${config.allowLive ? " · LIVE allowed" : ""}`);
}

main().catch((e) => {
  console.error(`[byline-mcp] fatal: ${(e as Error).message ?? e}`);
  process.exit(1);
});
