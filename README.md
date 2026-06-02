<div align="center">

# PipRail

**The drop-in payment layer for the agent economy — 24 chains, a couple of lines, straight to your wallet.**

[![npm](https://img.shields.io/npm/v/@piprail/sdk.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@piprail/sdk)
[![types](https://img.shields.io/npm/types/@piprail/sdk.svg?color=3178c6)](https://www.npmjs.com/package/@piprail/sdk)
[![license](https://img.shields.io/github/license/piprail/piprail.svg?color=brightgreen)](LICENSE)
[![x402 v2](https://img.shields.io/badge/x402-v2-6e56cf.svg)](https://x402.org)

</div>

`@piprail/sdk` lets any HTTP endpoint charge for itself and any agent pay for itself, using the open [x402](https://x402.org) "402 Payment Required" standard — across **24 chains in 8 families**: every major EVM chain plus **Solana, TON, Tron, NEAR, Sui, Stellar & the XRP Ledger**. No backend, no database, no account, no fee — payments settle **straight into your wallet**, verified locally against your own RPC.

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

That route now costs **0.05 USDC on Base**, paid to your wallet. One parameter picks the chain — `'base'`, `'bnb'`, `'arbitrum'`, `'solana'`, `'tron'`, `'sui'`, … 24 in all.

## What's in here

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

## Quick start

```bash
npm install              # install workspace deps

npm run build:sdk        # build the SDK
npm run test:sdk         # run the SDK test suite
npm run typecheck        # typecheck the SDK

npm run dev              # run the landing site → http://localhost:4321
npm run e2e              # live end-to-end against a local Anvil chain
```

## How it works

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

Verification is local and confirms the transaction succeeded, is recent, and actually moved the required amount of the right token to `payTo`. The x402 v2 spec (§7) explicitly endorses merchant-local verification — no facilitator required — so this is a spec-compliant shape, not a workaround. Self-custody throughout: the payer signs and broadcasts their own transfer straight to your wallet; PipRail never holds funds and never takes a cut.

## License

MIT — pure open source. See [LICENSE](LICENSE).
