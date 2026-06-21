# elizaos-plugin-piprail

Give an [elizaOS](https://github.com/elizaOS/eliza) agent a **budget-bound, self-custody wallet** to
pay **x402** ("HTTP 402 Payment Required") APIs across many chains — no facilitator, no fee. It wraps
the published [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) (`paymentTools`), so the
agent's own key signs against its own RPC and the spend **policy is a hard cap the model cannot cross**.

elizaOS already ships a sell-side `@elizaos/plugin-x402` (charge for *your* agent's services). This is
the **buy-side** counterpart: let your agent *pay* for things, on any supported chain.

## Install

```bash
npm install elizaos-plugin-piprail
```

Add it to your character and provide a funded wallet key + caps:

```jsonc
{
  "name": "PayBot",
  "plugins": ["elizaos-plugin-piprail"],
  "settings": {
    "PIPRAIL_CHAIN": "base",
    "PIPRAIL_MAX_AMOUNT": "0.10",   // per-payment cap
    "PIPRAIL_MAX_TOTAL": "5.00",    // lifetime cap
    "secrets": { "PIPRAIL_PRIVATE_KEY": "0x-your-funded-key" }
  }
}
```

See [`character.example.json`](./character.example.json).

## Actions

| Action | Wraps | Does |
|---|---|---|
| `PIPRAIL_PAY` | `piprail_pay_request` | Pay a gated x402 URL and return the unlocked resource |
| `PIPRAIL_QUOTE` | `piprail_quote_payment` | Price a 402 URL without paying |
| `PIPRAIL_PLAN` | `piprail_plan_payment` | Can the agent afford it, and the cheapest rail |
| `PIPRAIL_DISCOVER` | `piprail_discover` | Find x402-payable APIs matching a query |
| `PIPRAIL_BUDGET` | `piprail_budget` | What's been spent / what remains under the policy |
| `PIPRAIL_GUIDE` | `piprail_guide` | Explain the payment tools + the spend policy |

> The full 8-tool toolkit (these six plus `piprail_register` and `piprail_verify_receipt`, which are
> programmatic rather than conversational) is also available directly via `@piprail/sdk` or the
> `@piprail/mcp` MCP server.

## Config (character `settings` / `secrets`)

| Setting | Required | Default | Notes |
|---|---|---|---|
| `PIPRAIL_PRIVATE_KEY` | ✅ (in `secrets`) | — | Hex key of the wallet the agent spends from |
| `PIPRAIL_CHAIN` | — | `base` | `base`, `bnb`, `polygon`, `solana`, … |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Per-payment ceiling |
| `PIPRAIL_MAX_TOTAL` | — | `5.00` | Lifetime ceiling |

## Develop

```bash
npm install
npm run build       # tsup → dist/
npm run typecheck   # tsc --noEmit (against @elizaos/core 1.7.2)
npm run smoke       # offline shape check — no wallet, no network
```

MIT. Part of [PipRail](https://github.com/piprail/piprail) — *a tool you install, not a platform you join.*
