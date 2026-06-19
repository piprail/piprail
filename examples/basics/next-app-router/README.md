# Next.js (App Router) + PipRail

Gate a Route Handler with `createPaymentGate` — the framework-agnostic core. (`requirePayment` is Express-only; everywhere else uses the gate.)

## Run

```bash
npm install
npm run dev
```

Set your wallet (`payTo`) in `app/api/report/route.ts`, then:

```bash
curl -i http://localhost:3000/api/report     # → 402 + payment-required header
```

## How it works

`app/api/report/route.ts` builds the gate once, then in `GET` reads the `payment-signature` header and calls `gate.verify(...)`. The result has three kinds:

| `result.kind` | You respond with |
|---|---|
| `paid` | `200` + your data + the `payment-response` header (receipt) |
| `challenge` | `402` + the challenge JSON + the `payment-required` header |
| `invalid` | `402` + `toInvalidBody(result)` (wrong amount, expired, replayed…) |

That's the whole pattern — and it's **identical** for Hono, Fastify, Cloudflare Workers, Bun, and Deno: build a gate, switch on `verify()`.

## Next

- [`../../CONCEPTS.md`](../../CONCEPTS.md) — the mental model
- [SDK docs](../../../sdk/README.md) — multi-chain, custom tokens, policy controls
