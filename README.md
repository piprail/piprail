# PipRail

**The drop-in payment layer for the agent economy — any EVM chain and Solana, in a couple of lines.**

`@piprail/sdk` lets any HTTP endpoint charge for itself and any agent pay for itself, using the open [x402](https://x402.org) "402 Payment Required" standard. No backend, no database, no account, no fee — payments settle **straight into your wallet**, verified locally against your own RPC.

```bash
npm install @piprail/sdk viem
```

```ts
import { requirePayment } from '@piprail/sdk'

app.get('/report',
  requirePayment({ chain: 'base', amount: '0.05', payTo: '0xYourWallet…' }),
  (_req, res) => res.json({ report: 'TOP SECRET' }),
)
```

That route now costs 0.05 USDC on Base, paid to your wallet. One word picks the chain — `'base'`, `'bnb'`, `'arbitrum'`, … or `'solana'`.

## Structure

```
piprail/
├── sdk/         # @piprail/sdk — the npm package (the product)
├── site/        # piprail.com — static Astro 5 + Tailwind v4 landing
├── examples/    # runnable merchant + agent + live e2e against Anvil
└── .github/     # CI: SDK publish on tag · site deploy on push
```

No `contracts/`, no server, no database. PipRail is a tool you install, not a platform you sign up for.

## Quick start

```bash
npm install              # install workspace deps

npm run build:sdk        # build the SDK
npm run test:sdk         # run the SDK unit suite
npm run typecheck        # typecheck the SDK

npm run dev              # run the landing site → http://localhost:4321
npm run e2e              # live end-to-end against a local Anvil chain
```

## Packages

| Package | Path | Description |
|---|---|---|
| `@piprail/sdk` | `sdk/` | The SDK. Accept payments (`requirePayment` / `createPaymentGate`) and make them (`PipRailClient`), on any EVM chain and Solana. |
| `@piprail/site` | `site/` | `piprail.com` landing page. Static Astro 5 + Tailwind v4, deployed to Cloudflare Pages. |
| `@piprail/examples` | `examples/` | Runnable examples + live e2e tests against a local Anvil chain. |

See [sdk/README.md](sdk/README.md) for the full API.

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
