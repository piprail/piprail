# Express + PipRail

Gate a route with one middleware — a free route and a paid route, sharing one payment config.

## Run

```bash
npm install
PAY_TO=0xYourWallet… npm start
```

```bash
curl http://127.0.0.1:3000/health       # → free
curl http://127.0.0.1:3000/api/report   # → 402 + payment challenge
```

## How it works

- `GET /health` → free.
- `GET /api/report` → 0.05 USDC on Base, paid straight to your wallet.
  1. First request → `402` + a payment challenge.
  2. The caller pays on-chain (one USDC transfer to `payTo`).
  3. Retry with the proof → `200` + the data.

`requirePayment(...)` returns Express middleware — reuse the same config on as many routes as you want.

> Not on Express? Every other framework uses `createPaymentGate` instead — see [`../next-app-router`](../next-app-router).

## Next

- [`../agent`](../agent) — an agent that auto-pays a 402
- [`../../CONCEPTS.md`](../../CONCEPTS.md) — how verification works
- [SDK docs](../../../sdk/README.md)
