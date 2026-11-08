# @bylinecode/mcp

An MCP server that lets AI agents use Byline on NEAR. Through it an agent can:
- create its own identity for free;
- get swap quotes credited to it;
- pay with attribution;
- check and verify what was credited.

It speaks stdio, so any MCP client can use it: Claude Code, Claude Desktop, Cursor and others.

## Add it to a client

Build it once from the repo root:

```bash
npm ci
npm run build
```

Then register it. For Claude Code, put this in `.mcp.json`; an example is in [mcp.example.json](mcp.example.json):

```json
{
  "mcpServers": {
    "byline": {
      "command": "node",
      "args": ["/absolute/path/to/byline/packages/mcp/dist/index.js"],
      "env": { "BYLINE_NETWORK": "testnet" }
    }
  }
}
```

Then ask in plain words, for example: *"Use byline to give yourself an identity, quote 1 USDC → wNEAR, and show me it carries your code."*

The server tells the model the flow on connect, so nobody has to remember tool names.

## Tools

| Tool | What it does | Moves funds? |
| --- | --- | --- |
| `byline_create` | Gasless identity: generates a key here, signs a register message, and the registry creates the code plus `<code>.<registry>` with 0.03 NEAR. Returns the existing byline if the server has one. | No, the registry pays |
| `byline_register_with_wallet` | Registers from a funded account whose key is here. The registry picks the code. | About 0.01 NEAR of storage (**destructive**) |
| `byline_info` | Owner, payout, fee and accounts, plus the exact `referral`/`appFees` quotes will carry, with warnings | No |
| `byline_quote` | Real 1Click quote, always dry, credited to the code | No |
| `byline_swap` | Credited swap. Only previews unless `confirm: true`, on mainnet, with `BYLINE_ALLOW_LIVE=1` | Yes (**destructive**) |
| `byline_pay` | NEP-141 payment from the agent's account with memo `byline:<code>[ note]` | Yes (**destructive**) |
| `byline_link` | Credits an existing account to the byline (owner invites, account links; both keys local). Invites can't be withdrawn. | Storage only (**destructive**: signs transactions) |
| `byline_activity` | Recent transactions the byline's accounts signed, and payments carrying its memo, read live from the chain | No |
| `byline_verify` | Is this `tx_hash` or 1Click `deposit_address` credited to the code? Gives the reasons. | No |

## Configuration (env)

| Variable | Default | What |
| --- | --- | --- |
| `BYLINE_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `BYLINE_REGISTRY` | `byline.testnet` / `byline.near` | Registry contract |
| `BYLINE_RELAYER_URL` | hosted relayer | Where `byline_create` sends the signed message. Local: `http://localhost:8787/register` (`npm run relayer`) |
| `BYLINE_KEYS_DIR` | `~/.near-credentials` | Keys, near-cli layout. New agent keys are written here with mode 600. |
| `BYLINE_STATE_DIR` | `~/.byline` | Remembers which byline this server acts as |
| `BYLINE_RECORD` | unset | JSONL log the indexer counts (`data/byline-events.jsonl`) |
| `BYLINE_ALLOW_LIVE` | unset | Must be `1` for mainnet swaps, payments, registrations and links |
| `BYLINE_MAX_SWAP` | `10` | Largest live swap, in units of the `from` token |
| `BYLINE_MAX_PAY_RAW` | unset | Largest payment, in the token's smallest unit. Set it when `BYLINE_ALLOW_LIVE=1` |

## Safety

- **Nothing moves by default.** Quotes are dry, and swaps need `confirm: true`, mainnet and `BYLINE_ALLOW_LIVE=1`.
- **Spending is limited to the agent's own account.** `byline_pay` and `byline_swap` sign only as `<code>.<registry>`, never as the byline's owner, even when the owner's wallet key sits in the same keys directory. Live swaps are capped by `BYLINE_MAX_SWAP`, and payments by `BYLINE_MAX_PAY_RAW` when set.
- **Linking needs both keys here.** `byline_link` needs the owner's key even when an invite already exists, so nobody can invite one of your accounts to their byline and have a tool call accept it.
- **Chain text is labelled.** Memos, referrals and titles come back in their own `untrusted_*` fields or with a note to treat them as data.
- **Spending tools are annotated `destructiveHint: true`,** so clients can ask before calling them and auditors don't fuzz them.
- **Keys never pass through the model.** They're generated and read on disk, and only public information comes back.
- **Inputs are strict and outputs are typed.** Unknown keys, wrong types and out-of-range values come back as clean `isError` results, never a crash or a silent accept.
- **Logs go to stderr only,** so stdout stays the JSON-RPC channel.

## Tests

```bash
npm test -w @bylinecode/mcp
```

This spawns the built server over stdio with a real MCP client and calls every tool against live testnet and 1Click, with dry quotes only and no keys. Then it fuzzes every non-spending tool with missing, wrong-type, unknown and out-of-range input, which must all be rejected cleanly.

## Audit with mcprobe

```bash
npm run mcp:audit        # from the repo root; exits 1 below 80/100
```

This runs [mcprobe](https://github.com/alitiknazoglu/mcprobe), pinned to a reviewed commit: it lints the tool schemas, fuzzes the tools, and scores the server out of 100.

**How the audit is kept safe:** nothing in it can sign or spend.
- The script re-runs itself with only `PATH`, `HOME` and `BYLINE_*`.
- It passes the server's settings explicitly through mcprobe's `env`: a temp state dir and an **empty** keys dir.
- It refuses to run if the server could see any key.
- Every tool that signs, spends or creates an identity is annotated destructive, and mcprobe skips it.

**Latest result: 82/100 (B).** The script passes when there are no critical issues, error handling is 10 and schema quality is at least 9. The overall score is reported but not gated, because its latency part depends on the network.

| Dimension | Score | Why |
| --- | --- | --- |
| Metadata | 10 | Name, version and instructions are present |
| Schema | 9.4 | Four tools have only optional inputs (they default to this server's agent) |
| Error handling | 10 | 17/17 malformed inputs rejected cleanly; no silent accepts, hallucinated successes or crashes |
| Liveness | ~3.5 | 4/4 valid calls succeed; the rest is a latency penalty, because mcprobe targets 200 ms and these tools read the chain and 1Click live (p50 about 1.5 s) |
