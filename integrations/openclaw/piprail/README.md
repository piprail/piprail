# PipRail × OpenClaw

**Give an [OpenClaw](https://github.com/openclaw) agent a budget-bound payment wallet across every
major chain.** PipRail plugs into OpenClaw as a **standard MCP server** — the published
**[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** (`npx -y @piprail/mcp`) — so the agent
gets all **7 PipRail tools**, capped by a spend policy it cannot exceed. This folder is also a
publishable **[ClawHub](https://github.com/openclaw/clawhub) skill** ([`SKILL.md`](./SKILL.md)) — the
discoverable listing for it.

> **No bespoke plugin code.** The integration *is* the `@piprail/mcp` server plus an MCP config entry —
> nothing to build or maintain beyond the SDK/MCP we already ship. Tested against both the local build
> and the published `npx -y @piprail/mcp`: MCP handshake + all 8 tools.

## Why PipRail

Every other OpenClaw crypto skill routes through a facilitator or custodian. PipRail is
**backendless, no fee, self-custodial, every chain** — funds settle straight to the provider's
wallet, verified locally against *your* RPC, and the agent **cannot** exceed the cap you set.

## Setup

Add PipRail to `~/.openclaw/openclaw.json`. OpenClaw nests MCP servers under **`mcp.servers`** (not a
top-level `mcpServers`) — see [`openclaw.json`](./openclaw.json) for a copy-paste block:

```json
{
  "mcp": {
    "servers": {
      "piprail": {
        "command": "npx",
        "args": ["-y", "@piprail/mcp"],
        "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY", "PIPRAIL_CHAIN": "base", "PIPRAIL_MAX_TOTAL": "5.00" }
      }
    }
  }
}
```

Restart OpenClaw (or `openclaw mcp set`) and the `piprail_*` tools appear. You can also discover it on
ClawHub with `clawhub install piprail`. The env reference is on
[docs.piprail.com/mcp/configuration](https://docs.piprail.com/mcp/configuration/).

## Configure

Copy [`.env.example`](./.env.example) and fill in a **funded** wallet key. The full env reference:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | ✅ | — | Funded wallet key/seed for the chain (EVM `0x…`, Solana base58, or a mnemonic). **Never commit it.** |
| `PIPRAIL_CHAIN` | — | `base` | Chain to pay on (any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl`) |
| `PIPRAIL_CHAINS` | — | — | **Multi-chain** — comma-separated chains; each takes its own `PIPRAIL_<CHAIN>_KEY`. Pays whichever chain a 402 asks for. ([docs](https://docs.piprail.com/mcp/configuration/#pay-on-several-chains-from-one-server)) |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the **token's units** (≈ $ for USDC/USDT; native units for a coin) |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per token |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens, comma-separated |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers |
| `PIPRAIL_RPC_URL` | — | chain default | Custom RPC (recommended in production) |

> **Non-EVM chains** need their SDK peer library available alongside the server — see
> [docs.piprail.com/mcp/chains](https://docs.piprail.com/mcp/chains/). EVM chains need no extra peers.

## The 8 tools

`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · **`piprail_pay_request`** ·
`piprail_register` · `piprail_budget` · `piprail_guide` · `piprail_verify_receipt`. Only `piprail_pay_request` moves money; the
rest are read-only. Full reference: [docs.piprail.com/mcp/tools](https://docs.piprail.com/mcp/tools/).

## Verify it works

**One-command test** (zero dependencies — spawns the server the way OpenClaw does and drives the tools):

```bash
node verify.mjs                # offline: handshake + all 8 tools + read-only calls
node verify.mjs --live         # + quote the LIVE demo + prove the budget cap refuses overspend
PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live   # test a local build
```

`--live` proves the real round-trip without spending: it quotes `piprail.com/x402/demo` (0.01 USDC on
Base) and confirms a below-price cap **refuses** the payment. For the full **real OpenClaw run** (the
final sign-off) and the checklist, see [`integrations/TESTING.md`](../TESTING.md).

Then the manual path:

1. **Server starts:** `npx -y @piprail/mcp` (with the env set) prints its banner and speaks MCP over stdio.
2. **Quote the live demo:** ask the agent to `piprail_quote_payment("https://piprail.com/x402/demo")` —
   it returns a real price (0.01 USDC on Base).
3. **Pay it:** `piprail_pay_request("https://piprail.com/x402/demo")` → a real `200` + a receipt.
4. **Budget holds:** lower `PIPRAIL_MAX_TOTAL` below the price and confirm the agent is refused
   (`declined: true`) with no funds moved.

## Publishing the skill (maintainers)

The ClawHub CLI ships on **npm** (`github.com/openclaw/clawhub`, by OpenClaw's creator) — **not** the
PyPI `clawhub` (that's an unrelated package). The skill is published under the **`@piprail` org publisher**
(not a personal handle), so its page shows the PipRail identity. Install the CLI, log in once with GitHub
(free), then publish from the repo root:

```bash
npm i -g clawhub                              # the official OpenClaw ClawHub CLI — NOT `pip install clawhub`
clawhub login                                 # GitHub auth: opens a browser (or `--device`, or `--token <t>`)
clawhub publisher create piprail --display-name "PipRail"   # one-time: claim the @piprail org (skip if it exists)
clawhub skill publish integrations/openclaw/piprail \
  --owner piprail --slug piprail --name "PipRail" --version 1.0.3 \
  --tags latest --changelog "…what changed…"
```

- **`--owner piprail` is required** — it lists the skill under **@piprail**, not your personal handle. The
  publisher must exist first (`clawhub publisher create piprail`); republish an already-personal skill with
  `--owner piprail --migrate-owner` to move it.
- **`--slug piprail`** — the folder is `piprail`, so the slug matches it (pass it explicitly to be safe).
  It lists as **`clawhub install piprail`** (or `openclaw skills install piprail`); the older
  `piprail-openclaw-skill` / `piprail-openclaw` slugs **redirect**. `--version` is optional (semver, recommended).
- Publishing needs only a **GitHub account** (free; no paid signup). ClawHub runs **automated security
  checks** on publish — `clawhub scan download piprail --version X.Y.Z` fetches the report,
  `clawhub inspect piprail` confirms it's live.
- The **actual tool wiring is the `mcp.servers` block above** — the ClawHub listing is discovery + the
  install/instructions; OpenClaw spawns `@piprail/mcp` from the config (the canonical MCP-wrapping-skill
  pattern, same as `openclaw/skills` `mcporter`). The CLI evolves — `clawhub skill publish --help` is the
  source of truth at publish time.

## Links

- **Integration docs:** [docs.piprail.com/integrations/openclaw](https://docs.piprail.com/integrations/openclaw/)
- **MCP server:** [`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp) · [docs](https://docs.piprail.com/mcp/overview/)
- **PipRail:** [piprail.com](https://piprail.com) · [github.com/piprail/piprail](https://github.com/piprail/piprail) (MIT)
- **Follow along:** ⭐ [Star on GitHub](https://github.com/piprail/piprail) · 𝕏 [@piprailhq](https://x.com/piprailhq)
