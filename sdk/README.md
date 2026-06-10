# @piprail/sdk

**Accept and make x402 crypto payments — on any EVM chain, Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and the XRP Ledger — in a couple of lines.**

No middleman. No database. No fee. No account. Payments settle **straight into your wallet**, verified locally against your own RPC. Drop one middleware in front of a route and it's paid-only; point an agent at a paid URL and it pays itself.

```bash
npm install @piprail/sdk viem
```

> ### 📖 Full documentation → **[docs.piprail.com](https://docs.piprail.com)**
> This README is the 60-second tour. Every function, option, chain, and example — plus the MCP server, spend controls, discovery, and the full error model — lives in the docs. **The docs are the source of truth.**

---

## Take a payment — one line

```ts
import express from 'express'
import { requirePayment } from '@piprail/sdk'

express()
  .get('/report',
    requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet' }),
    (_req, res) => res.json({ report: 'TOP SECRET' }),
  )
  .listen(3000)
```

That route now costs **0.05 USDC on Base**, paid to your wallet. The first request gets a `402` with payment instructions; once the caller pays on-chain, the request goes through. You didn't paste a token address, run a server, deploy a contract, or sign up for anything.

→ [Accepting payments](https://docs.piprail.com/accepting-payments/require-payment-and-gate/)

## Make a payment — wrap `fetch`

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { privateKey: process.env.AGENT_KEY } })

const res = await client.fetch('https://api.example.com/report') // pays the 402 for you
const data = await res.json()
```

On a `402`, the client reads the challenge, pays on-chain, waits for confirmation, and retries with proof — all inside `client.fetch`. The same app can **take** payments and **make** them.

→ [Making payments](https://docs.piprail.com/making-payments/piprail-client/)

## Built for agents — spend safely

Hand an LLM a funded wallet without losing sleep. Opt into a `policy` and the client refuses anything outside it **before any on-chain send** — and learn a price without paying it, plan a payment against your real balances, and read back exactly what you spent.

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  policy: { maxAmount: '0.10', maxTotal: '5.00', tokens: ['USDC'], hosts: ['*.example.com'] },
})

const plan = await client.planPayment(url) // can I pay? balance + gas + recipient readiness
if (plan?.payable) await client.fetch(url)
```

→ [Spend controls](https://docs.piprail.com/spend-controls/payment-policy/) ·
[`planPayment()`](https://docs.piprail.com/making-payments/plan-payment/) ·
[Agent toolkit](https://docs.piprail.com/agent-toolkit/payment-tools/)

## One word picks the chain

```ts
requirePayment({ chain: 'base',   token: 'USDC',   amount: '0.05', payTo }) // USDC on Base
requirePayment({ chain: 'solana', token: 'USDC',   amount: '0.05', payTo }) // USDC on Solana
requirePayment({ chain: 'tron',   token: 'USDT',   amount: '1',    payTo }) // USD₮ on Tron
requirePayment({ chain: 'base',   token: 'native', amount: '0.001', payTo }) // ETH on Base
```

Every major EVM chain plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and the XRP Ledger — one `chain` parameter. USDC almost everywhere, USDT on most, native coin on every family, and any other token by address. No allowlist: pass a viem `Chain` or `{ id, rpcUrl }` for any other EVM chain.

→ [Chains & tokens](https://docs.piprail.com/chains/overview/) (the full list + per-chain setup)

## Typed errors

Every failure is typed and understandable — never a raw chain blob. Catch a thrown `PipRailError` (stable `.code`), or read why a proof was rejected (`VerifyErrorCode`). PipRail even tells a payer-vs-recipient problem apart, so a human or an agent knows exactly what to fix.

```ts
import { PipRailError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PipRailError) console.error(err.code, err.message) // e.g. INSUFFICIENT_FUNDS
}
```

→ [Error handling](https://docs.piprail.com/errors/error-model/)

---

## What's in the docs

| | |
|---|---|
| **[Getting started](https://docs.piprail.com/getting-started/introduction/)** | Install · quickstart · how it works |
| **[Accepting payments](https://docs.piprail.com/accepting-payments/require-payment-and-gate/)** | `requirePayment` · `createPaymentGate` · multi-chain · the `exact` rail |
| **[Making payments](https://docs.piprail.com/making-payments/piprail-client/)** | `PipRailClient` · `quote` · `estimateCost` · `planPayment` · auto-route |
| **[Spend controls](https://docs.piprail.com/spend-controls/payment-policy/)** | Budgets · time envelope · the spend ledger |
| **[Agent toolkit](https://docs.piprail.com/agent-toolkit/payment-tools/)** | `paymentTools` · the agent guide · NL renderers |
| **[Discovery](https://docs.piprail.com/discovery/discover-and-register/)** | Find & be found on the open x402 indexes ($0, no backend) |
| **[Chains](https://docs.piprail.com/chains/overview/)** | Every chain, per-family setup & caveats |
| **[Errors](https://docs.piprail.com/errors/error-model/)** | The full error model — what you and your agent see |
| **[MCP server](https://docs.piprail.com/mcp/overview/)** | Give any AI agent a budget-bound wallet |
| **[Reference](https://docs.piprail.com/reference/api/)** | The complete API surface |

## Facts

- **No backend, no database, no account, no fee, no hosted facilitator** — self-custody, verified locally against your own RPC.
- **Pure TypeScript** with a `viem` peer dependency; non-EVM families are optional, lazy-loaded peers. Runs headless or in the browser.
- **x402 v2-conformant**; the default `onchain-proof` scheme is backendless. Opt into the standard `exact` rail to also pay/get-paid by any x402 client.

## License & trademark

The code is **MIT** — use it, fork it, ship it. **PipRail™**, the logo, and the `@piprail` npm scope are trademarks of the PipRail project: build on the code freely, but please don't call a fork "PipRail" or imply it's official. See [TRADEMARK.md](https://github.com/piprail/piprail/blob/main/TRADEMARK.md).
