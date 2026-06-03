# PipRail — concepts & mental model

PipRail is the open **x402 "402 Payment Required"** standard, verified locally against your own RPC, with **no backend, no database, no fee**. Your server emits a payment challenge; the agent pays on-chain and proves it; your server checks the proof. That's the whole thing.

## The 402 loop

```
  Agent                                   Your server (with PipRail)
    │  GET /report                              │
    │ ─────────────────────────────────────────►│  requirePayment / createPaymentGate
    │ ◄──────────── 402 + payment-required ──────│  (issues a challenge: chain, token,
    │                                            │   amount, payTo, nonce)
    │  pay on-chain — one transfer to payTo      │
    │ ───────────────────►  [the blockchain]     │
    │  GET /report + payment-signature           │
    │ ─────────────────────────────────────────►│  verify against own RPC:
    │                                            │   • succeeded?  • recent?
    │                                            │   • right amount/token to payTo?
    │                                            │   • not already used (replay)?
    │ ◄──────────── 200 + data + payment-response│
```

## Who owns what

| | Owner | Held by PipRail? |
|---|---|---|
| Private keys | agent / merchant | **No** — keys never leave your process |
| Funds in transit | agent → chain → merchant | **No** — the blockchain, not us |
| RPC endpoint | you (or a public one) | **No** — you choose the trust anchor |
| Receipts / ledger | you (optional; DB-free) | **No** — store what you like |

PipRail takes **no cut** and never custodies funds. Zero lock-in.

## Which primitive do I use?

```
Accepting payments?
 ├─ Express / Connect ──────► requirePayment({ chain, token, amount, payTo })   // middleware
 └─ anything else ──────────► createPaymentGate({ chain, token, amount, payTo }) // gate.verify()
      (Next.js, Hono, Fastify, Workers, Bun, Deno)

Paying for things?
 └─ PipRailClient({ chain, wallet, policy? })  →  client.fetch(url)   // auto-pays a 402

Exposing payment to a model?
 └─ paymentTools(client)  →  [piprail_quote_payment, piprail_pay_request]
```

`token` is **always required** — there is no default. A gate states exactly what it accepts (`'USDC'`, `'USDT'`, `'native'`, or a custom `{ address, decimals }`).

## Local verification — trust your own RPC

The server checks the transaction against **its own RPC**, not a third party: the tx succeeded, is recent (within `maxTimeoutSeconds`), moved at least the required amount of the right token to `payTo`, and hasn't been redeemed before. No oracle, no facilitator, no fee.

## Replay protection

- **Memo-bound chains** (Stellar, XRPL, TON, NEAR): the challenge nonce rides *inside* the transfer, so a proof is cryptographically bound to its challenge.
- **Digest-bound chains** (EVM, Solana, Tron, Sui): a single-use proof set + a tight recency window.

Single-process uses an in-memory set; for multiple instances, plug in your own store:

```ts
createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo,
  isUsed: async (key) => (await redis.exists(key)) === 1,
  markUsed: async (key) => { await redis.set(key, '1', { EX: 600 }) },
})
```

## Paying safely (agents)

A funded key loose on the internet needs guardrails. The client enforces an opt-in `policy` **before any on-chain send**:

```ts
import { PipRailClient, PaymentDeclinedError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  policy: { maxAmount: '0.10', maxTotal: '5.00', tokens: ['USDC'], hosts: ['*.example.com'] },
  onBeforePay: (quote) => quote.withinPolicy, // final say
})

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PaymentDeclinedError) console.log('over budget:', err.message)
  else throw err
}
```

An over-limit request throws `PaymentDeclinedError` — **no funds move**. The safety lives in code, not in a prompt.

## Budget the gas, too

You pay the token (USDC) **and** burn the chain's native coin (ETH/SOL/TON/…) for gas:

```ts
const { quote, cost } = await client.estimateCost(url)
// quote.amountFormatted = '0.05' USDC ; cost.feeFormatted = native-coin gas (never throws)
```

`quote(url)` prices without paying; `estimateCost(url)` adds the gas estimate.

## Errors — two channels

1. **Thrown** (config/wallet/budget): a `PipRailError` subclass with a stable `.code` (`INSUFFICIENT_FUNDS`, `UNKNOWN_TOKEN`, `PAYMENT_DECLINED`, …). Catch with `instanceof`.
2. **Returned** (proof rejected): the gate gives `{ kind: 'invalid', error, detail }` where `error` is a `VerifyErrorCode` (`amount_too_low`, `transfer_not_found`, `payment_expired`, …) — turn it into a 402 body with `toInvalidBody(result)`.

## More

- [SDK README](../sdk/README.md) — full API, all 26 chains, wallet formats, custom tokens.
- [ERRORS.md](../sdk/ERRORS.md) — every error code and how to handle it.
- [examples/README.md](./README.md) — pick a framework and run it.
