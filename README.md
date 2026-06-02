<div align="center">

<img src="site/public/og.png" alt="PipRail — the payment layer for the agent economy" width="840" />

<br/>
<br/>

[![npm](https://img.shields.io/npm/v/@piprail/sdk.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@piprail/sdk)
[![types](https://img.shields.io/npm/types/@piprail/sdk.svg?logo=typescript&logoColor=white&color=3178c6)](https://www.npmjs.com/package/@piprail/sdk)
[![license](https://img.shields.io/github/license/piprail/piprail.svg?color=2ee6a6)](LICENSE)
[![x402 v2](https://img.shields.io/badge/x402-v2-6e56cf.svg)](https://x402.org)
[![chains](https://img.shields.io/badge/chains-24%20across%208%20families-2ee6a6.svg)](#-supported-chains)

**Let any HTTP endpoint charge for itself, and any agent pay for itself — across 24 chains, in a couple of lines.**

[Website](https://piprail.com) · [npm](https://www.npmjs.com/package/@piprail/sdk) · [Full docs →](sdk/README.md)

</div>

---

`@piprail/sdk` implements the open [x402](https://x402.org) **"402 Payment Required"** standard with **no backend, no database, no account, and no fee**. Payments settle **straight into your wallet**, verified locally against your own RPC — across every major EVM chain plus **Solana, TON, Tron, NEAR, Sui, Stellar & the XRP Ledger**.

```bash
npm install @piprail/sdk viem
```

### 💸 Charge for an endpoint

```ts
import { requirePayment } from '@piprail/sdk'

app.get('/report',
  requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet…' }),
  (_req, res) => res.json({ report: 'TOP SECRET' }),
)
```

That route now costs **0.05 USDC on Base**, paid straight to your wallet. The first request gets a `402` with payment instructions; once the caller pays on-chain, it goes through. One parameter picks the chain.

### 🤖 Let an agent pay for it

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { privateKey: process.env.AGENT_KEY } })

// Hits a 402, pays it on-chain, waits for confirmation, retries with proof — automatically.
const res = await client.fetch('https://api.example.com/report')
```

The same app can **take** payments and **make** them. Built for autonomous agents: install, add a wallet, monetize or pay — nothing else to wire up.

## 🌐 Supported chains

**24 chains across 8 families** — name one with a single `chain:` parameter. Non-EVM families lazy-load on first use, so a pure-EVM install never downloads their libraries.

| Family | Built-in chains | Tokens |
|---|---|---|
| **EVM** (17) | Ethereum · Base · Arbitrum · Optimism · Polygon · BNB · Avalanche · Mantle · Sonic · Linea · Scroll · Celo · zkSync · Unichain · World Chain · Sei · Injective | USDC + USDT* |
| **Solana** | Solana | USDC · USDT |
| **TON** | The Open Network | USD₮ |
| **Tron** | Tron | USD₮ |
| **NEAR** | NEAR | USDC · USDT |
| **Sui** | Sui | USDC |
| **Stellar** | Stellar | USDC · EURC |
| **XRP Ledger** | XRPL | USDC · RLUSD |

<sub>\*USDC on every EVM chain; USDT on all of them except Base, World Chain, and Sei. Any other EVM chain works via a viem `Chain` or `{ id, rpcUrl }` — no allowlist. Every token address was verified on-chain before shipping.</sub>

## ⚙️ How it works

```
Agent                                  Your server
  │  GET /report                            │
  │ ───────────────────────────────────────►│  requirePayment
  │ ◄──────────── 402 + payment-required ────│  (issues a challenge)
  │  pay on-chain (one transfer to payTo)    │
  │ ───────────────────►  [the chain]        │
  │  GET /report  + payment-signature        │
  │ ───────────────────────────────────────►│  verifies the tx against
  │ ◄──────────── 200 + your content ────────│  its own RPC, then next()
```

Verification is local and confirms the transaction **succeeded, is recent, and actually moved the required amount of the right token to `payTo`**. The x402 v2 spec (§7) explicitly endorses merchant-local verification — no facilitator required — so this is a spec-compliant shape, not a workaround. **Self-custody throughout:** the payer signs and broadcasts their own transfer straight to your wallet; PipRail never holds funds and never takes a cut.

## 📦 What's in here

```
piprail/
├── sdk/         # @piprail/sdk — the npm package (the product)
├── site/        # piprail.com — the landing site (Astro 5 + Tailwind v4, deploys to Netlify)
├── examples/    # runnable merchant + agent demos + a live Anvil end-to-end
└── .github/     # CI: build/test checks · npm publish on a sdk-v* tag
```

**`@piprail/sdk`** is the product — and the only thing published to npm. `site/` is the source of [piprail.com](https://piprail.com); `examples/` holds runnable demos. Both live here in the repo but aren't npm packages.

→ Full API & guides: **[sdk/README.md](sdk/README.md)**

No `contracts/`, no server, no database. PipRail is a tool you install, not a platform you sign up for.

## 🛠️ Quick start

```bash
npm install              # install workspace deps

npm run build:sdk        # build the SDK
npm run test:sdk         # run the SDK test suite
npm run typecheck        # typecheck the SDK

npm run dev              # run the landing site → http://localhost:4321
npm run e2e              # live end-to-end against a local Anvil chain
```

## 📄 License

[MIT](LICENSE) — pure open source. Use it, fork it, ship it.

<div align="center">
<br/>
<sub>Built for the agent economy · <a href="https://piprail.com">piprail.com</a></sub>
</div>
