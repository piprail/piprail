# PipRail × Hermes

**Give a [Hermes](https://github.com/NousResearch/hermes-agent) agent a budget-bound payment wallet
across every major chain.** PipRail plugs into Hermes as a **standard MCP server** — the published
**[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** (`npx -y @piprail/mcp`) — so the agent
gets all **7 PipRail tools**, capped by a spend policy it cannot exceed. This folder also carries the
**Hermes MCP catalog manifest** ([`manifest.yaml`](./manifest.yaml)) and a **Skills Hub skill**
([`SKILL.md`](./SKILL.md)) — the two ways Hermes users discover it.

> **No bespoke plugin code.** Hermes is Python; `@piprail/sdk` is TypeScript with no Python bindings,
> so there is **no in-process path** — and none is needed. The integration *is* the `@piprail/mcp`
> server plus one config entry. Tested against both the local build and the published
> `npx -y @piprail/mcp`: MCP handshake + all 8 tools (see [`verify.mjs`](./verify.mjs)).

## Why PipRail

Hermes has **no native payment rail** (Nous Portal is fiat-subscription only) — there's even an open
RFC for one ([Issue #38280](https://github.com/NousResearch/hermes-agent/issues/38280), "Agent
Economic Layer"). PipRail is the drop-in answer: **backendless, no fee, self-custodial, every chain**
— funds settle straight to the provider's wallet, verified locally against *your* RPC, and the agent
**cannot** exceed the cap you set.

## Setup

Add PipRail to `~/.hermes/config.yaml`. Hermes nests MCP servers under the top-level **`mcp_servers`**
key — see [`config.yaml`](./config.yaml) for a copy-paste block:

```yaml
mcp_servers:
  piprail:
    command: "npx"
    args: ["-y", "@piprail/mcp"]
    env:
      PIPRAIL_PRIVATE_KEY: "${PIPRAIL_PRIVATE_KEY}"   # from ~/.hermes/.env — see below
      PIPRAIL_CHAIN: "base"
      PIPRAIL_MAX_TOTAL: "5.00"
```

Then run **`/reload-mcp`** in a session (or start a new one) and the eight tools appear as
`mcp_piprail_*`. Equivalents: `hermes mcp add piprail --command npx --args -y @piprail/mcp`, or — once
the [catalog PR](#publishing-maintainers) merges — **`hermes mcp install piprail`**.

> **Two key gotchas, both about secrets:** Hermes does **not** inherit your shell environment into the
> subprocess, so `PIPRAIL_PRIVATE_KEY` **must** be in the server's `env:` block or pay stays
> `WALLET_REQUIRED`. Keep the literal value in `~/.hermes/.env` (chmod 600) and reference it as
> `${PIPRAIL_PRIVATE_KEY}` — Hermes expands `${VAR}` (but **not** bare `$VAR`).

**Read-only first run:** omit the key entirely and PipRail boots key-less —
discover/quote/register/budget/guide all work; only pay/plan need the wallet.

## Configure

Copy [`.env.example`](./.env.example) into `~/.hermes/.env` and fill in a **funded** wallet key.
The full env reference:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | only to **pay** | — | Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). **Omit for read-only.** Not an API key — never commit it. |
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
rest are read-only. In Hermes they surface to the model namespaced as `mcp_piprail_*`. Full reference:
[docs.piprail.com/mcp/tools](https://docs.piprail.com/mcp/tools/).

## Verify it works

**One-command test** (zero dependencies — spawns the server the way Hermes does and drives the tools):

```bash
node verify.mjs                # offline: handshake + all 8 tools + read-only calls
node verify.mjs --live         # + quote the LIVE demo + prove the budget cap refuses overspend
PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live   # test a local build
```

`--live` proves the real round-trip without spending: it quotes `piprail.com/x402/demo` (0.01 USDC on
Base) and confirms a below-price cap **refuses** the payment. For the full **real Hermes run** (the
final sign-off) and the checklist, see [`integrations/TESTING.md`](../../TESTING.md).

## Publishing (maintainers)

Two complementary listings — both are PRs into `NousResearch/hermes-agent`:

1. **MCP catalog (primary)** — PR [`manifest.yaml`](./manifest.yaml) to
   `optional-mcps/piprail/manifest.yaml`. Merge = "Nous approval" and makes `hermes mcp install piprail`
   work natively. The catalog currently holds only `linear` + `n8n`, so PipRail would be an early
   payment entry. Reference **Issue [#38280](https://github.com/NousResearch/hermes-agent/issues/38280)**
   in the PR — it's the open request this answers.
2. **Skills Hub (optional)** — publish [`SKILL.md`](./SKILL.md):
   `hermes skills publish integrations/hermes/piprail --to github --repo piprail/skills`, or PR it to
   `optional-skills/blockchain/piprail/` for `official` trust. Community web indexes worth a listing:
   [hermesatlas.com](https://hermesatlas.com) (open an issue) and
   [SamurAIGPT/awesome-hermes-agent](https://github.com/SamurAIGPT/awesome-hermes-agent) (PR a line).

Expect a security scan on any pay-capable skill — lead with the **self-custodial / spend-cap /
no-custody / key-less read-only** framing. The full plan: [`.claude/plans/framework-integrations/04-hermes.md`](../../../.claude/plans/framework-integrations/04-hermes.md).

## Links

- **Integration docs:** [docs.piprail.com/integrations/hermes](https://docs.piprail.com/integrations/hermes/)
- **MCP server:** [`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp) · [docs](https://docs.piprail.com/mcp/overview/)
- **PipRail:** [piprail.com](https://piprail.com) · [github.com/piprail/piprail](https://github.com/piprail/piprail) (MIT)
- **Follow along:** ⭐ [Star on GitHub](https://github.com/piprail/piprail) · 𝕏 [@piprailhq](https://x.com/piprailhq)
