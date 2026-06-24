---
title: Presets & self-test
description: createPaywall and createTipJar — named sugar over createPaymentGate — plus gate.selfTest(), a never-throw config check. The fastest way to accept a payment.
sidebar:
  order: 2
---

## The fastest way to accept a payment

The **presets** are named sugar over [`createPaymentGate`](/accepting-payments/require-payment-and-gate/):
say *what you're selling* instead of wiring a gate. Each one resolves to a standard gate, so the
`402` it builds is **byte-identical** to the hand-written equivalent — no new wire, no new behaviour,
just less to type and a clearer mental model. `token` defaults to **USDC**; every other
`createPaymentGate` option (`onPaid`, `exact`, `receipts`, `discovery`, `isUsed`/`markUsed`, …) still
works.

## `createPaywall` — a fixed price for a resource

The API / SaaS / premium-content case: one resource, one price.

```ts
import { createPaywall, toWorker } from '@piprail/sdk'

const gate = createPaywall({ chain: 'base', amount: '0.05', payTo: '0xYourWallet' })
// token defaults to USDC. Drive it with any adapter:
export default toWorker(gate, () => Response.json({ report: 'unlocked' }))
```

| Option | Required? | Notes |
| --- | --- | --- |
| `chain` | required | EVM (`'base'`, `'bnb'`, …) or a non-EVM family name. |
| `amount` | required | The fixed price, e.g. `'0.05'`. |
| `payTo` | required | Your receiving address — **no private key** (receiving needs only the address). |
| `token` | default `'USDC'` | A symbol, `'native'`, or a custom `{ address, decimals }`. |
| …rest | optional | Any other `createPaymentGate` option (`onPaid`, `exact`, `receipts`, …). |

## `createTipJar` — pay what you want (≥ a minimum)

The creator / tip / donation case. The gate is priced at `min`, and the on-chain verify rejects only
an **under**-payment (`amount_too_low`) — so a payer can always give more. The minimum is a floor,
not a fixed price.

```ts
import { createTipJar } from '@piprail/sdk'

const gate = createTipJar({ chain: 'base', min: '1.00', payTo: '0xYourWallet' })
// accepts any payment ≥ 1.00 USDC.
```

## `gate.selfTest()` — "did I wire this right?"

A read-only config check that **never throws** and **never signs or sends**. It resolves the gate's
rails (the same lazy resolution the first `challenge()` does) and reports what it would charge — or
why it can't. Perfect for a startup assertion or an `npm run verify` script before you deploy.

```ts
const result = await gate.selfTest()
// {
//   ok: true,
//   rails: [{ network: 'eip155:8453', asset: '0x833…', symbol: 'USDC',
//             decimals: 6, amount: '0.05', payTo: '0x…', schemes: ['onchain-proof'] }],
//   warnings: [],
// }

if (!result.ok) throw new Error(`Gate misconfigured: ${result.error}`)
```

A malformed `payTo`, an unknown token, or an unresolvable chain returns `{ ok: false, error }` — never
an exception. A custom token with no built-in symbol is surfaced as a non-fatal `warning`.

## Driving the gate

A preset returns the same [`PaymentGate`](/accepting-payments/require-payment-and-gate/#the-paymentgate-object)
as `createPaymentGate`, so drive it with the built-in
[framework adapters](/accepting-payments/framework-adapters/) — `toFetchHandler` for any `fetch`
runtime (Next.js, Netlify, Bun, Deno, Hono, Vercel, …) or `toWorker` for Cloudflare — or
`requirePayment` for Express.
