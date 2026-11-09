# @by-line/mcp

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
      "command": "npx",
      "args": ["-y", "@by-line/mcp@0.2.0"],
      "env": { "BYLINE_NETWORK": "testnet" }
    }
  }
}
```

Working from a clone instead? Use `"command": "node"` with `"args": ["<clone>/packages/mcp/dist/index.js"]` after `npm run build`.

Then ask in plain words, for example: *"Use byline to give yourself an identity, quote 1 USDC → wNEAR, and show me it carries your code."*

The server tells the model the flow on connect, so nobody has to remember tool names.

## Tools

| Tool | What it does | Moves funds? |
| --- | --- | --- |
| `byline_create` | Gasless identity: give it a `title` (the agent's label); it generates a key here, signs a register message, and the registry creates the code plus `<code>.<registry>` with 0.03 NEAR. Returns the existing byline if the server has one. | No, the registry pays |
| `byline_register_with_wallet` | Registers from a funded account whose key is here. The registry picks the code. | About 0.01 NEAR of storage (**destructive**) |
| `byline_info` | Owner, payout, fee and accounts, plus the exact `referral`/`appFees` quotes will carry, with warnings | No |
| `byline_quote` | Real 1Click quote, always dry, credited to the code | No |
| `byline_swap` | Credited swap. Only previews unless `confirm: true`, on mainnet, with `BYLINE_ALLOW_LIVE=1` | Yes (**destructive**) |
| `byline_pay` | NEP-141 payment from the agent's account with memo `byline:<code>[ note]` | Yes (**destructive**) |
| `byline_link` | Credits an existing account to the byline (owner invites, account links; both keys local). Invites can't be withdrawn. | Storage only (**destructive**: signs transactions) |
| `byline_activity` | Recent transactions the byline's accounts signed, and payments carrying its memo, read live from the chain. Needs `code`. | No |
| `byline_verify` | Is this `target` credited to the code? A NEAR transaction hash or a 1Click deposit address (detected from its shape). Gives the reasons. | No |

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
| `BYLINE_MAX_SWAP_USD` | `10` | Largest live swap in US dollars, checked on the live quote right before the deposit |
| `BYLINE_MAX_SPEND_USD` | `50` | Total live swaps this server process may make, in US dollars |
| `BYLINE_ALLOW_EXTERNAL_RECIPIENT` | unset | `1` lets a live swap send its output to an account other than the agent's own |
| `BYLINE_MAX_PAY` | unset | Largest payment in the token's own units (e.g. `5` means 5 USDC or 5 wNEAR). On mainnet this or `BYLINE_MAX_PAY_RAW` is required |
| `BYLINE_MAX_PAY_RAW` | unset | Largest payment in the token's smallest unit |

## Safety

- **Nothing moves by default.** Quotes are dry, and swaps need `confirm: true`, mainnet and `BYLINE_ALLOW_LIVE=1`.
- **Spending is limited to the agent's own account.** `byline_pay` and `byline_swap` sign only as `<code>.<registry>`, never as the byline's owner, even when the owner's wallet key sits in the same keys directory. Live swaps are capped in dollars per swap (`BYLINE_MAX_SWAP_USD`) and per process (`BYLINE_MAX_SPEND_USD`), go to the agent's own account unless `BYLINE_ALLOW_EXTERNAL_RECIPIENT=1`, and are exact-input only. Mainnet payments need `confirm: true` and an operator-set cap (`BYLINE_MAX_PAY` or `BYLINE_MAX_PAY_RAW`). `byline_verify` credits a swap only once 1Click reports it settled (SUCCESS).
- **Linking needs both keys here.** `byline_link` needs the owner's key even when an invite already exists, so nobody can invite one of your accounts to their byline and have a tool call accept it.
- **Chain text is labelled.** Memos, referrals and titles come back in their own `untrusted_*` fields or with a note to treat them as data.
- **Spending tools are annotated `destructiveHint: true`,** so clients can ask before calling them and auditors don't fuzz them.
- **Keys never pass through the model.** They're generated and read on disk, and only public information comes back.
- **Inputs are strict and outputs are typed.** Unknown keys, wrong types and out-of-range values come back as clean `isError` results, never a crash or a silent accept.
- **Logs go to stderr only,** so stdout stays the JSON-RPC channel.

## Tests

```bash
npm test -w @by-line/mcp
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

**Latest result: 90–91/100 (A)** over three runs. The script passes when there are no critical issues, error handling is 10 and schema quality is at least 9. The overall score is reported but not gated, because its latency part depends on the network.

| Dimension | Score | Why |
| --- | --- | --- |
| Metadata | 10 | Name, version and instructions are present |
| Schema | 9.86 | Only `byline_info` has no required input: its `code` is optional on purpose, so an agent can ask "do I have a byline yet?" |
| Error handling | 10 | Every malformed input rejected cleanly; no silent accepts, hallucinated successes or crashes |
| Liveness | 6–6.5 | 4/4 valid calls succeed; the rest is mcprobe's latency penalty (target 200 ms). `byline_info` and `byline_verify` answer in about 0.3 s; the median is held up by 1Click's own quote API (about 1–1.4 s) |

What made it faster: independent reads run in parallel, the server warms 1Click's token list and its own agent's attribution at start, dry quotes skip the record lookup, and a transaction signed by `<code>.<registry>` is credited without an extra registry read (only the registry can create that account). The audit uses the `NEAR_RPC_*` endpoints from `.env` when set, as the server would in production.
