# @piprail/sdk

**Accept and make [x402](https://x402.org) crypto payments — on any EVM chain plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar & the XRP Ledger — in a couple of lines.**

No middleman, no database, no fee, no account. Payments settle **straight into your wallet**, verified locally against your own RPC. Gate a route to make it paid-only; point an agent at a paid URL and it pays itself.

```bash
npm install @piprail/sdk viem
```

> ### 📖 Full documentation → **[docs.piprail.com](https://docs.piprail.com)**
> The docs are the single, searchable **source of truth** — every function, option, chain, and example, plus the MCP server, spend controls, discovery, and the complete error model. This README is just the front door.

---

## Charge for an endpoint

```ts
import { requirePayment } from '@piprail/sdk'

app.get('/report',
  requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet…' }),
  (_req, res) => res.json({ report: 'TOP SECRET' }),
)
```

That route now costs **0.05 USDC on Base**, paid straight to your wallet. One parameter picks the chain. → [Accepting payments](https://docs.piprail.com/accepting-payments/require-payment-and-gate/)

## Let an agent pay for it

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { privateKey: process.env.AGENT_KEY } })

const res = await client.fetch('https://api.example.com/report') // hits the 402, pays it, retries with proof
```

The same app can **take** payments and **make** them. → [Making payments](https://docs.piprail.com/making-payments/piprail-client/)

---

## Documentation

| | |
|---|---|
| **[Getting started](https://docs.piprail.com/getting-started/introduction/)** | Install · quickstart · how it works |
| **[Accepting payments](https://docs.piprail.com/accepting-payments/require-payment-and-gate/)** | `requirePayment` · `createPaymentGate` · the `exact` rail |
| **[Making payments](https://docs.piprail.com/making-payments/piprail-client/)** | `PipRailClient` · `quote` · `estimateCost` · `planPayment` · auto-route |
| **[Spend controls](https://docs.piprail.com/spend-controls/payment-policy/)** | Budgets · time envelope · the spend ledger |
| **[Agent toolkit](https://docs.piprail.com/agent-toolkit/payment-tools/)** | `paymentTools` · the agent guide · NL renderers |
| **[Discovery](https://docs.piprail.com/discovery/discover-and-register/)** | Find & be found on the open x402 indexes ($0, no backend) |
| **[Chains & tokens](https://docs.piprail.com/chains/overview/)** | Every chain, per-family setup & caveats |
| **[Errors](https://docs.piprail.com/errors/error-model/)** | The complete typed error model |
| **[MCP server](https://docs.piprail.com/mcp/overview/)** | Give any AI agent a budget-bound wallet |
| **[Reference](https://docs.piprail.com/reference/api/)** | The complete API surface |

## Spread the word

PipRail is free, open-source, and has no backend to sell you. If it saved you from building a payments backend, help other developers (and their agents) find it:

⭐ **[Star on GitHub](https://github.com/piprail/piprail)** &nbsp;·&nbsp; 𝕏 **[Follow @piprailhq](https://x.com/piprailhq)** &nbsp;·&nbsp; 🌐 **[piprail.com](https://piprail.com)** &nbsp;·&nbsp; 📖 **[docs.piprail.com](https://docs.piprail.com)**

## License & trademark

The code is **MIT** — use it, fork it, ship it. **PipRail™**, the logo, and the `@piprail` npm scope are trademarks of the PipRail project: build on the code freely, but please don't call a fork "PipRail" or imply it's official. See [TRADEMARK.md](https://github.com/piprail/piprail/blob/main/TRADEMARK.md).
