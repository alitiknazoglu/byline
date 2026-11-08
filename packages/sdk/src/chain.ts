/**
 * Reading Byline activity off the chain: FastNear's transaction API and the parsers that turn a
 * transaction into its byline facts (signer, calls, memo payments, registry events).
 * Browser-safe. Used by the indexer, the MCP server and the web terminal.
 */
export * from "./chain/fastnear.js";
export * from "./chain/parse.js";
