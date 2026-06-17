<div align="center">

<img src="site/public/og.png" alt="PipRail — the payment layer for the agent economy" width="840" />

<br/>
<br/>

[![@piprail/sdk](https://img.shields.io/npm/v/@piprail/sdk.svg?logo=npm&label=%40piprail%2Fsdk&color=cb3837)](https://www.npmjs.com/package/@piprail/sdk)
[![@piprail/mcp](https://img.shields.io/npm/v/@piprail/mcp.svg?logo=npm&label=%40piprail%2Fmcp&color=2ee6a6)](https://www.npmjs.com/package/@piprail/mcp)
[![types](https://img.shields.io/npm/types/@piprail/sdk.svg?logo=typescript&logoColor=white&color=3178c6)](https://www.npmjs.com/package/@piprail/sdk)
[![license](https://img.shields.io/github/license/piprail/piprail.svg?color=2ee6a6)](LICENSE)
[![x402 v2](https://img.shields.io/badge/x402-v2-6e56cf.svg)](https://x402.org)
[![chains](https://img.shields.io/badge/chains-29%20across%2010%20families-2ee6a6.svg)](https://docs.piprail.com/chains/overview/)
[![GitHub stars](https://img.shields.io/github/stars/piprail/piprail?style=flat&logo=github&label=Star&color=2ee6a6)](https://github.com/piprail/piprail)
[![Follow @piprailhq](https://img.shields.io/badge/Follow-%40piprailhq-1d9bf0?logo=x&logoColor=white)](https://x.com/piprailhq)

**Let any HTTP endpoint charge for itself, and any agent pay for itself — across every major chain, in a couple of lines.**

[Website](https://piprail.com) · [Documentation](https://docs.piprail.com) · [npm](https://www.npmjs.com/package/@piprail/sdk)

</div>

---

PipRail implements the open [x402](https://x402.org) **"402 Payment Required"** standard with **no backend, no database, no account, and no fee**. Payments settle **straight into your wallet**, verified locally against your own RPC — across every major EVM chain plus **Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar & the XRP Ledger**. Self-custodial throughout.

## How a payment moves

<div align="center">

<img src="site/public/flow.png" alt="How a payment moves — the full life of one payment, side by side. Left, the traditional MPP path (Stripe + Tempo): the agent's money is held in transit through a processor and a permissioned chain across roughly five hops, takes ~T+2 days to become spendable, and can be frozen or reversed. Right, PipRail's x402 wallet-to-wallet rail: the agent pays the merchant's wallet directly in a single on-chain transaction, the merchant gate verifies it locally, funds are spendable in seconds, there's no custodian, and the fee is 0%." width="840" />

<sub>**The middle is the difference.** A traditional processor holds the money in transit, takes days to release it, and can freeze or reverse it. PipRail removes the middle entirely — the agent pays the merchant's wallet directly, the merchant verifies it locally against their own RPC, and it settles in one transaction at **0% fee**, self-custodial end to end. &nbsp;<a href="https://piprail.com">See it on piprail.com →</a></sub>

</div>

> ### 📖 Full documentation → **[docs.piprail.com](https://docs.piprail.com)**
> The single, searchable **source of truth** — every function, option, chain, and example. This README is just the front door.

## What's here

| | |
|---|---|
| **[`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk)** | The TypeScript SDK — accept & make x402 payments. The product. |
| **[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** | An MCP server giving any AI agent a budget-bound wallet ([`io.github.piprail/mcp`](https://registry.modelcontextprotocol.io)). |
| **[`integrations/`](integrations)** | First-party agent-framework integrations — e.g. **OpenClaw** (`clawhub install piprail`) & **Hermes**. Each wraps `@piprail/mcp`; nothing new to build. |
| **[`site/`](site)** · **[`docs/`](docs)** · **[`examples/`](examples)** | [piprail.com](https://piprail.com) · the [docs.piprail.com](https://docs.piprail.com) source · runnable demos. |

## Quick taste

```bash
npm install @piprail/sdk viem
```

```ts
import { requirePayment } from '@piprail/sdk'

app.get('/report',
  requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet…' }),
  (_req, res) => res.json({ report: 'TOP SECRET' }),
)
```

That route now costs **0.05 USDC on Base**, paid straight to your wallet. Point an agent at it and it pays itself — name any chain with a single `chain:` parameter. The full quickstart, every chain, the MCP server, spend controls, and the error model are in the **[docs](https://docs.piprail.com)**.

## Documentation & links

- **[docs.piprail.com](https://docs.piprail.com)** — the complete manual (source of truth)
- **[MCP server](https://docs.piprail.com/mcp/overview/)** · **[Discovery](https://docs.piprail.com/discovery/discover-and-register/)** · **[Supported chains](https://docs.piprail.com/chains/overview/)**
- **[Integrations](https://docs.piprail.com/integrations/)** — drop PipRail into agent frameworks ([OpenClaw](integrations/openclaw/piprail) + [Hermes](integrations/hermes/piprail) today, more coming)
- **[Runnable examples](examples)** — merchant + agent demos, a live Anvil end-to-end, and the [`why-402`](examples/why-402/) teardown
- **[Releasing](RELEASING.md)** (tag-driven CI) · **[Contributing](CONTRIBUTING.md)** (DCO)

## Spread the word

PipRail is free, open-source, and has no backend to sell you — so word of mouth is how it grows. If it saved you from building a payments backend, the best way to give back is to help other developers (and their agents) find it:

- ⭐ **[Star PipRail on GitHub](https://github.com/piprail/piprail)** — the #1 way to help others discover it
- 𝕏 **[Follow @piprailhq](https://x.com/piprailhq)** — new chains, ship logs, and agent-payment tips
- 🌐 **[piprail.com](https://piprail.com)** · 📖 **[docs.piprail.com](https://docs.piprail.com)**

## License & trademark

**Code:** [MIT](LICENSE) — use it, fork it, ship it, commercially or otherwise.

**Name & brand:** **PipRail™**, the logo, and the `@piprail` npm scope are trademarks of the PipRail project — MIT covers the *code*, not the *name*. Build on it freely; just don't call a fork "PipRail" or imply it's official. See [TRADEMARK.md](TRADEMARK.md).

<div align="center">
<br/>
<img src="site/public/logo.png" alt="PipRail" width="64" />

<sub>Built for the agent economy · <a href="https://piprail.com">piprail.com</a></sub>
</div>
