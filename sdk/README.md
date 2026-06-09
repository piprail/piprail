# @piprail/sdk

**Accept crypto payments from any HTTP request — on any EVM chain, Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and the XRP Ledger — in a couple of lines.**

No middleman. No database. No fee. No account. Payments settle **straight into your wallet**, verified locally against your own RPC. Drop one middleware in front of a route and it's paid-only; point an agent at a paid URL and it pays itself.

```bash
npm install @piprail/sdk viem
```

## Take payments — one line

```ts
import express from 'express'
import { requirePayment } from '@piprail/sdk'

express()
  .get('/report',
    requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet…' }),
    (_req, res) => res.json({ report: 'TOP SECRET' }),
  )
  .listen(3000)
```

That route now costs **0.05 USDC on Base**, paid to your wallet. The first request gets a `402` with payment instructions; once the caller pays on-chain, the request goes through. You didn't paste a token address, run a server, deploy a contract, or sign up for anything.

## Make payments — wrap fetch

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  wallet: { privateKey: process.env.AGENT_KEY },
  chain: 'base',
})

const res = await client.fetch('https://api.example.com/report') // pays the 402 for you
const data = await res.json()
```

On a `402`, the client reads the challenge, sends the payment on-chain, waits for confirmation, and retries with proof — all inside `client.fetch`. The same app can **take** payments with `requirePayment` and **make** them with `PipRailClient`. Built for autonomous agents: install, add a wallet, monetize or pay — nothing else to wire up.

## Universal payments — get paid by *any* x402 client

PipRail's envelope is x402 **v2**-conformant, and its default `onchain-proof` scheme is backendless (the payer broadcasts, you verify locally — zero merchant key, zero merchant gas). To **also** be payable by a standard x402 client (Coinbase's `x402-fetch`, `@x402/fetch`, anything speaking the ratified `exact`/EIP-3009 scheme), opt into a standard `exact` rail — advertised **alongside** `onchain-proof` in the same 402:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet…',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } },
})
```

Now the gate offers two rails: a standard x402 client picks `exact`; a PipRail client picks `onchain-proof`. The `exact` rail is **self-settled** — your own `relayer` key broadcasts the client's signed EIP-3009 authorization, so the **payer spends no gas** (you do, to receive). The EIP-712 token domain is read from the contract, so it's correct on every chain (USDC's domain name is `"USD Coin"`, not the symbol). Prefer not to run a relayer key? Delegate settlement to a third-party facilitator you choose — PipRail still hosts nothing:

```ts
exact: { settle: { facilitator: 'https://x402.org/facilitator' } }
```

EVM + EIP-3009 tokens only (USDC, EURC — not USDT, not native; those stay `onchain-proof`). Omit `exact` and the gate is byte-identical to today. Proven end-to-end: a real `@x402/fetch` reference client settles against a PipRail gate on Base mainnet.

## Built for agents — spend safely

A funded key loose on the internet needs guardrails. Opt in to a `policy` and the client refuses anything outside it **before any on-chain send** — plus learn a price without paying it, approve each payment, and read back exactly what you spent. All opt-in, all local, no backend; omit it and the client behaves exactly as before.

```ts
const client = new PipRailClient({
  wallet: { privateKey: process.env.AGENT_KEY },
  chain: 'base',
  policy: {
    maxAmount: '0.10',        // never pay more than $0.10 for one call
    maxTotal: '5.00',         // never spend more than $5 total (per token)
    chains: ['base'],         // only on Base
    tokens: ['USDC'],         // only in USDC (use 'native' to also allow the chain's coin)
    hosts: ['*.example.com'], // only these hosts
  },
  onBeforePay: (q) => Number(q.amountFormatted) <= 0.05, // final say on each payment
})

// 1) Learn the price WITHOUT paying — decide if it's worth it.
const q = await client.quote('https://api.example.com/report')
//  → { amountFormatted: '0.05', symbol: 'USDC', chain: 'base', withinPolicy: true, … } | null

// 2) Know the GAS too — the native-coin fee to SEND it (you pay USDC, but burn ETH/SOL/TRX for gas).
const est = await client.estimateCost('https://api.example.com/report')
//  → { quote: {…}, cost: { feeSymbol: 'ETH', feeFormatted: '0.000105', basis: 'estimated', … } } | null

// 3) Pay (auto). Over-budget / declined → throws PaymentDeclinedError; nothing moves.
const res = await client.fetch('https://api.example.com/report')

// 4) Account for it.
client.spent() // → { count, byAsset: [{ symbol:'USDC', totalFormatted:'0.05', … }], records }
```

**The budget can't be fooled.** `maxAmount`/`maxTotal` are enforced against the token's **true** decimals (the SDK's own, via the driver) — a server can't slip past a cap by understating the price, and an asset the SDK can't recognise is refused unless you set `allowUnknownTokens`. `quote()` even flags a `symbolMismatch` when a challenge's stated symbol disagrees with the real token.

**`policy.tokens` takes symbols *or* `'native'`.** List stablecoin symbols (`'USDC'`, `'USDT'`, …) and/or the chain-agnostic alias **`'native'`** to allow the chain's own coin (ETH/BNB/TRX/XLM/…) on any family — the same word the accept side uses (`token: 'native'`), so you never name per-chain tickers (the real ticker works too). It only ever matches a genuinely native asset, so it never loosens a stablecoin-only list. The MCP server's `PIPRAIL_TOKENS` is the same allowlist.

**Know the gas before you pay.** `client.estimateCost(url)` returns the quote **and** a `CostEstimate` — the network fee in the chain's **native coin** (you pay in USDC but burn ETH / SOL / TON / XLM / XRP / TRX on gas, a separate balance the agent must keep topped up). It's best-effort and labelled (`cost.basis`): a live-RPC read where cheap (`'estimated'` — EVM gas price, XRPL fee), a typical-cost constant otherwise (`'heuristic'`), and it never throws. Most valuable on **Tron**, where a USD₮ transfer can cost real TRX. So an agent can budget the *total* — payment **+** gas — before any funds move. Every driver implements it; the math is extracted per-chain and shaped uniformly by one shared `nativeCost()` helper.

### Plan before you pay — `planPayment()` (never fumble a payment)

`quote()` tells you the price and `estimateCost()` the gas — **`planPayment(url)`** closes the loop: **one read-only call** that checks, against your wallet's *own* holdings, whether a 402 will actually go through — and if not, exactly what to fix. No funds move.

```ts
const plan = await client.planPayment(url)

if (plan?.payable) {
  await client.fetch(url, { autoRoute: true })   // pays plan.best — the cheapest rail you can settle
} else {
  console.log(plan?.fundingHint)
  // "Have the USDC, but need ~0.000021 ETH for gas on base (have 0)."
  // "Recipient 2OT6…GC5E4 can't receive on algorand yet — must opt into the USDC ASA."
  // "Top up 0.04 USDC on base (have 0.01)."
}
```

For **every rail the 402 offers on your chain**, the plan reads **token balance + native-coin gas + recipient-readiness** (trustline / ATA / `storage_deposit` / ASA opt-in / activation) and returns:
- **`payable`** + **`best`** — the cheapest rail you can actually settle (recipient confirmed able to receive);
- **`options[]`** — each rail with typed **`blockers`** (`INSUFFICIENT_TOKEN` · `INSUFFICIENT_GAS` · `RECIPIENT_NOT_READY` · `OUTSIDE_POLICY`), soft **`warnings`** (`SYMBOL_MISMATCH`, `THIN_GAS_MARGIN`, `BALANCE_UNREADABLE`, …), a **`shortfall`**, the live **`balance`**, and **`recipient.fix`**;
- **`fundingHint`** — one human sentence on exactly what to top up.

**Why it's the agent unlock.** The official x402 client picks `accepts[0]` blind and learns it can't pay only when the broadcast reverts (no token, no gas) or the transfer silently strands (recipient not set up to receive). `planPayment` turns those runtime failures into a pre-checked decision — and on the no-facilitator path *you* pay your own gas, so "I hold USDC but no ETH" is a first-class answer, not a crash. It **never throws for a read hiccup** (a throttled RPC surfaces as `state: 'unknown'` + a warning, never a false "broke"), returns `null` when the URL isn't gated, and *explains* "this is offered on solana, base — you're on xrpl" instead of erroring. `client.canAfford(url)` is the one-boolean convenience.

**Auto-route (opt-in).** `new PipRailClient({ autoRoute: true })` (or `fetch(url, { autoRoute: true })`) makes `fetch` pay the cheapest *settleable* rail instead of the first policy-passing one — refusing with `PaymentDeclinedError` + the funding hint before any send. **Default off; the zero-config path is unchanged.**

**Across chains.** A client is bound to one chain; **`planAcross([baseClient, solanaClient, …], url)`** runs each plan in parallel and merges them payable-first, so an agent holding funds on several chains learns which to use. (No price oracle — cross-coin ties break on the order you list the clients.)

### Hand an LLM a budget-bound wallet

`paymentTools(client)` returns framework-agnostic tool descriptors (name + description + JSON Schema + `invoke`) — drop them into MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling, or LangChain in a couple of lines. The budget rides on the client, so the model can't overspend.

```ts
import { paymentTools } from '@piprail/sdk'
const tools = paymentTools(client) // → [piprail_discover, piprail_quote_payment, piprail_plan_payment, piprail_pay_request, piprail_register]
```

Each descriptor also carries advisory **`annotations`** (MCP-style `ToolAnnotations` — `title`,
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`): the three reads are flagged
**read-only**, `piprail_pay_request` is flagged **value-moving** (the one tool that spends), and
`piprail_register` is non-destructive — so an MCP client can render the right consent. They're hints,
not the boundary; the spend policy is. `@piprail/mcp` advertises them on the wire.

See [`examples/agent-tools.mjs`](../examples/agent-tools.mjs) for MCP / AI-SDK wiring.

## Be discoverable — find and be found ($0, no backend)

A 402 endpoint is payable, but nobody can *find* it. PipRail closes that gap by building on the
**open** x402 indexes that already exist (402 Index, the CDP Bazaar read API, x402scan) — **nothing
PipRail-hosted, no registry, no database.** All opt-in; the pay path is untouched. There's **no PipRail
account and no x402 sign-up anywhere** — the only thing ever registered is a merchant's own URL.
**The four steps below are the whole playbook** — an agent can follow them top to bottom (every method
never throws and returns a typed result that says what to do next); [DISCOVERY.md](./DISCOVERY.md) is
the deep reference.

> **Experimental.** Discovery integrates with third-party open indexes whose conventions are young
> and moving — treat this layer as experimental. The read path + 402 Index register are live-verified;
> x402scan SIWX isn't yet. Note **402 Index probes your URL and only lists endpoints that actually
> return a `402`** — so register a *deployed* gate, not a marketing page. (DISCOVERY.md §10 has the log.)

**1) List a resource you run** — one call, no auth, no signature, no funds:

```ts
const client = new PipRailClient({ wallet: { privateKey: KEY }, chain: 'base' })

const outcomes = await client.register('https://api.example.com/report', {
  name: 'Market Report', priceUsd: 0.05, asset: 'USDC',
  targets: ['402index', 'x402scan'], // 402index is the default; x402scan adds SIWX (Base/Solana)
})
// Each outcome carries its LIFECYCLE — read `visibility` + `note`. "ok:true" ≠ "searchable now":
//  • 402index → { ok:true, visibility:'pending-review', note:'… verify your domain for instant approval' }
//  • x402scan → { ok:true, visibility:'live',           note:"… discover() does NOT read x402scan" }
```

**2) Flip 402 Index `pending-review` → searchable** — verify the domain you control (no funds, no sign-up):

```ts
const claim = await client.claimDomain('https://api.example.com/report', { contactEmail: 'you@example.com' })
// Serve claim.verificationHash as the ENTIRE body of claim.verificationUrl
//   (https://api.example.com/.well-known/402index-verify.txt) — then:
await client.verifyDomain('api.example.com') // → { ok:true, status:'verified', servicesCount }
// Now every pending listing on that domain is approved + searchable.
```

**Works on every chain.** 402 Index needs no signature and has no chain allowlist, so *any* chain —
a preset, a non-EVM family, or a custom `{ id, rpcUrl }` chain — can be listed and found; `discover()`
never silently hides a resource whose chain it can't resolve. (x402scan is the one Base/Solana-only
*bonus* target.)

**Built-with attribution (tasteful, honest).** Your emitted `/openapi.json` carries an
`x-generator: "@piprail/sdk"` stamp by default (opt out with `attribution: false`), and every index
request sends a `User-Agent: @piprail/sdk` — so the tech spreads through the files indexes crawl and
the logs operators read, never by spamming listings. An opt-in `register(url, { attribution: true })`
adds a best-effort `via` tag; it's off by default (it's your listing).

**3) Find resources to pay** — read the open indexes (free), filtered to your chain by default:

```ts
const hits = await client.discover({ query: 'weather', maxPrice: 0.01 })
// → [{ resource, name, source, priceUsd, rails: [...] }, …]
const res = await client.fetch(hits[0].resource) // then quote → plan → pay as usual
```

`discover()` reads **402 Index + CDP Bazaar**, **not x402scan** (its reads are paid) — a live x402scan
listing won't appear here, so don't read that absence as failure. `network` defaults to `'self'` (your
chain); pass `'any'` for every chain, or a CAIP-2 id (`'eip155:8453'`). Slugs map to CAIP-2 via
`SLUG_TO_CAIP2`; an unresolved network is kept, never hidden.

**4) Make your endpoint self-describing** — turn your gate's config into the artifacts a crawler reads
(pure, no I/O); serve them on **your own** origin. **x402scan REQUIRES** a resolvable input schema (your
`/openapi.json` or an `extensions.bazaar` block in the 402 body), so this is what makes an x402scan
listing accepted:

```ts
import { createPaymentGate, buildOpenApi, buildWellKnownX402, buildX402DnsTxt } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo })
const desc = await gate.describe('https://api.example.com/report')
const openapi = buildOpenApi({ origin: 'https://api.example.com', resources: [desc] })
// serve at /openapi.json — each priced op carries an `x-payment-info` block + a root `x-generator` stamp.
const wellKnown = buildWellKnownX402({ resources: [desc] }) // serve at /.well-known/x402
// buildX402DnsTxt(...) emits the _x402 DNS line too.
```

**Know each index before you call** — the facts are one import, `DIRECTORY_INFO`, and `register()`
projects them onto every outcome (`visibility` + `note`), so an agent never has to guess:

| Index | Write auth | Chains | On a successful register | Read by `discover()`? |
|---|---|---|---|---|
| **402 Index** (default) | none | any | `pending-review` → `verifyDomain()` for instant approval | ✅ yes |
| **x402scan** | one wallet sig (SIWX) | Base / Solana | `live` on x402scan.com | ❌ no (paid reads) |
| **CDP Bazaar** | — (facilitator-only) | — | `not-listable` for PipRail (backendless) | ✅ read-only |

```ts
import { DIRECTORY_INFO } from '@piprail/sdk'
DIRECTORY_INFO['x402scan'].readByDiscover // false — branch on this, don't guess
```

For an LLM/MCP these are two more tools — **`piprail_discover`** (find) and **`piprail_register`**
(be found) — on top of the three payment tools, so `paymentTools(client)` / `@piprail/mcp` expose **five**.

> **Two honest caveats.** The open indexes assume the mainstream `exact` scheme, so to be *usefully*
> listed also offer a standard `exact` USDC rail on Base/Solana (`discover()` results are
> cross-scheme; `fetch()` pays only PipRail `onchain-proof` rails directly). And **x402scan indexes
> Base/Solana only** — 402 Index has no such limit, so it's the default register target. There is no
> single ratified discovery standard yet; OpenAPI-first is an emerging multi-vendor convention.

### Accept several chains at once

`requirePayment` (and `createPaymentGate`) take an **`accept: [...]`** array — one challenge that's payable on **any** of several chains/tokens, across **all ten families** (EVM, Solana, TON, Tron, Stellar, XRPL, NEAR, Sui, Aptos, Algorand). The agent pays with whatever it holds:

```ts
requirePayment({
  accept: [
    { chain: 'base',   token: 'USDC', amount: '0.05', payTo: '0xYourEvmWallet…', rpcUrl: BASE_RPC },
    { chain: 'tron',   token: 'USDT', amount: '0.05', payTo: 'TYourTronWallet…', rpcUrl: TRON_RPC },
    { chain: 'xrpl',   token: 'USDC', amount: '0.05', payTo: 'rYourXrplWallet…' },
    { chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourSolWallet…',   rpcUrl: SOL_RPC },
  ],
})
```

Each option takes its **own optional `rpcUrl`** (falling back to the top-level `rpcUrl` when omitted), so a multi-chain merchant pins a reliable endpoint **per chain** — one throttled public RPC can't take down verification for the others. (The `rpcUrl` is used server-side only; it's never leaked into the challenge.) **In production, set it on every chain** — public RPCs are rate-limited.

How the multi-chain case is handled, end-to-end:

- **Gate:** each option resolves through its own driver with its own `rpcUrl` (its `payTo` is validated and its token resolved) and is listed in the challenge's `accepts[]`, sharing one nonce. `payTo` falls back to the top-level `payTo` when omitted — but address shapes differ per family, so give a per-option `payTo` for each non-EVM chain.
- **Payer:** a `PipRailClient` is bound to **one** chain (its `chain` + wallet). It picks the offered accept whose network it supports **and** its `policy` allows, pays that one, and ignores the rest. `quote(url)` and `estimateCost(url)` price/estimate **that** chosen chain — so to compare cost across chains, point one client per chain at the same URL and compare their `estimateCost` results.
- **Verify:** the gate selects the matching requirement by **network + asset** and re-derives every checked field from **its own** trusted spec — a forged `accepted` echo can't redirect it (a wrong asset/network simply doesn't match). The same proof can't be redeemed twice.

## One word picks the chain

```ts
requirePayment({ chain: 'base',     token: 'USDC',   amount: '0.05', payTo }) // USDC on Base
requirePayment({ chain: 'arbitrum', token: 'USDC',   amount: '0.05', payTo }) // USDC on Arbitrum
requirePayment({ chain: 'bnb',      token: 'USDT',   amount: '1',    payTo }) // USDT on BNB
requirePayment({ chain: 'solana',   token: 'USDC',   amount: '0.05', payTo }) // USDC on Solana
requirePayment({ chain: 'ton',      token: 'USDT',   amount: '1',    payTo }) // USD₮ on TON
requirePayment({ chain: 'tron',     token: 'USDT',   amount: '1',    payTo }) // USD₮ on Tron
requirePayment({ chain: 'xrpl',     token: 'USDC',   amount: '0.05', payTo }) // USDC on the XRP Ledger
requirePayment({ chain: 'near',     token: 'USDC',   amount: '0.05', payTo }) // USDC on NEAR
requirePayment({ chain: 'sui',      token: 'USDC',   amount: '0.05', payTo }) // USDC on Sui

// Prefer the chain's native coin? Same one-liner — token: 'native'.
requirePayment({ chain: 'ethereum', token: 'native', amount: '0.001', payTo }) // ETH
requirePayment({ chain: 'base',     token: 'native', amount: '0.001', payTo }) // ETH on Base
requirePayment({ chain: 'bnb',      token: 'native', amount: '0.01',  payTo }) // BNB
requirePayment({ chain: 'solana',   token: 'native', amount: '0.1',   payTo }) // SOL
requirePayment({ chain: 'ton',      token: 'native', amount: '1',     payTo }) // TON
requirePayment({ chain: 'xrpl',     token: 'native', amount: '1',     payTo }) // XRP
```

**Native or stablecoin — your choice, on every chain.** Every gate accepts the chain's native coin (ETH, BNB, POL, AVAX, SOL, TON, XLM, XRP, SUI, NEAR, **TRX**, …) just as readily as a stablecoin — set `token: 'native'` and the SDK fills in the right decimals (18 on EVM, 9 on Solana/TON/Sui, 8 on Aptos, 7 on Stellar, 6 on XRPL/Tron/Algorand, 24 on NEAR). Verification, replay protection, and self-custody are identical to the stablecoin path — across **all ten families, no exceptions**. (On **NEAR**, native is the zero-setup path — no `storage_deposit` — while the NEP-141 token path needs registration; see the NEAR note. On **Tron**, USD₮ is the default since TRX is volatile gas, but native TRX works too.)

`token` is **required** — every gate states exactly what it accepts, so there's never any doubt whether a route takes USDC, USDT, or the native coin. Name a built-in symbol (`'USDC'`, `'USDT'`), use `'native'` for the chain's own coin (ETH, BNB, SOL, TON, XLM, …), or pass a custom token by address. The symbol is all you write — the SDK fills in the contract + decimals.

### Built-in chains (mainnet)

Every token address below was verified on-chain (symbol + decimals) before shipping.

| `chain` | Network | Tokens |
|---|---|---|
| `'ethereum'` | Ethereum | USDC, USDT |
| `'base'` | Base | USDC |
| `'arbitrum'` | Arbitrum | USDC, USDT |
| `'optimism'` | Optimism | USDC, USDT |
| `'polygon'` | Polygon | USDC, USDT |
| `'bnb'` | BNB Chain | USDC, USDT |
| `'avalanche'` | Avalanche | USDC, USDT |
| `'mantle'` | Mantle | USDC, USDT |
| `'sonic'` | Sonic | USDC, USDT |
| `'linea'` | Linea | USDC, USDT |
| `'scroll'` | Scroll | USDC, USDT |
| `'celo'` | Celo | USDC, USDT |
| `'zksync'` | zkSync Era | USDC, USDT |
| `'unichain'` | Unichain | USDC, USDT |
| `'worldchain'` | World Chain | USDC |
| `'sei'` | Sei | USDC |
| `'injective'` | Injective | USDC, USDT |
| `'hyperevm'` | HyperEVM (Hyperliquid) | USDC |
| `'monad'` | Monad | USDC |
| `'kaia'` | Kaia (ex-Klaytn) | USDT |
| `'solana'` | Solana | USDC, USDT |
| `'ton'` | TON | USDT |
| `'tron'` | Tron | USDT |
| `'near'` | NEAR | USDC, USDT |
| `'sui'` | Sui | USDC |
| `'aptos'` | Aptos | USDC, USDT |
| `'algorand'` | Algorand | USDC |
| `'stellar'` | Stellar | USDC, EURC |
| `'xrpl'` | XRP Ledger | USDC, RLUSD |

**TON note:** native **USDC does not exist on TON** (Circle doesn't issue it there) — so it's intentionally absent. USD₮ (Tether) is native and built in; for USDe / bridged tokens pass a custom jetton (below).

**Tron note:** native **USDC doesn't exist on Tron** (Circle discontinued it; the only USDC there is a third-party bridge) — so it's intentionally absent. USD₮ (TRC-20) is native and built in, and is the default since TRX is volatile gas. **Native TRX is also supported** (`token: 'native'`, digest-bound) for completeness — or pass a custom TRC-20.

**NEAR note:** **native NEAR works** (`token: 'native'`, 24dp) and is the **zero-setup** path — no `storage_deposit`, and a transfer even *creates* a fresh implicit recipient. Or pay in a token: ships **both native USDC + USDT** (Circle's native USDC `17208628…`, NOT the bridged `…factory.bridge.near`; Tether's native `usdt.tether-token.near`) — but a NEP-141 recipient (and the payer) must be **`storage_deposit`-registered** on that token once before it can receive (see CHAINS.md). NEAR is the volatile gas coin, so for stable pricing pay in USDC/USDT; for no-setup flows, native NEAR is ideal.

**Sui note:** **USDC only** — no native USDT on Sui (Wormhole-bridged only). Native SUI works with `token: 'native'`.

**Algorand note:** **USDC only** — Tether deprecated USDT on Algorand (frozen 2025-09-01), so it's intentionally absent (pass it as a custom `{ assetId, decimals }`). Native ALGO works with `token: 'native'` (the zero-setup path). To **receive** USDC the recipient must **opt into the ASA** once (a 0-amount self-transfer — like a trustline); a not-opted-in recipient surfaces `RECIPIENT_NOT_READY`. The challenge nonce binds inside the transaction's note field (Template A). Algorand's `exact` scheme is part of the official x402 standard; the incumbent on-chain path there uses a hosted facilitator, so PipRail is the backendless, no-facilitator option.

**Stellar / XRPL note:** to **receive** an issued asset (USDC/EURC on Stellar; USDC/RLUSD on XRPL) the recipient needs a one-time **trustline** for that asset, and the account must already exist / be activated (a small native reserve — **locked, not spent**). Native XLM/XRP need no trustline. The payer needs its own trustline too.

### Using TON? Grab one free API key (≈30 seconds)

TON is the only chain with a one-time setup step — and it's tiny. TON's free public RPC
(toncenter) is **rate-limited**, so without your own key, payment confirmation stalls or
times out. The fix is exactly **one parameter**: a `rpcUrl` with a free key in the URL.

1. **Get a free key** — message **[@tonapibot](https://t.me/tonapibot)** on Telegram (or sign
   up at [toncenter.com](https://toncenter.com/)). ~30 seconds, no card, no KYC.
2. **Drop it into `rpcUrl`** on the gate (and the client) — that's it:

```ts
const TON_RPC = 'https://toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY' // ← your free key in the URL

// Take a TON payment — one extra field vs any other chain:
app.get('/report',
  requirePayment({ chain: 'ton', token: 'USDT', amount: '0.05', payTo: 'UQ…', rpcUrl: TON_RPC }),
  (_req, res) => res.json({ report: 'TOP SECRET' }),
)

// Pay on TON — same one extra field:
const client = new PipRailClient({ chain: 'ton', wallet: { mnemonic }, rpcUrl: TON_RPC })
```

That's the **whole** TON setup. Everything else is automatic: USD₮ is built in (native USDC
doesn't exist on TON), native TON works too (`token: 'native'`), and the merchant needs no
setup — the payer's gas deploys its jetton wallet on first receipt. **Skip the key → rate
limits; add it → TON is as seamless as every other chain.**

> 📖 **Per-chain setup, caveats & wallet formats → [CHAINS.md](CHAINS.md).** Exactly what each chain needs *before* it can pay or receive — the NEAR `storage_deposit`, Stellar/XRPL trustlines, TON API key, Tron gas, which chains accept `native`, and the wallet shape per family. **Most chains need nothing; NEAR, TON, Stellar, XRPL and Tron have caveats — read them before shipping those.**

If a chain you need doesn't ship the token you want, pass it by address (below). `token` is required on every gate — no silent default.

### Any other chain or token — no allowlist

Don't see your chain? Pass a [viem](https://viem.sh) `Chain` or a bare `{ id, rpcUrl }`, plus the exact token to be paid in — you have full control:

```ts
requirePayment({
  chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' }, // any EVM chain
  token: { address: '0x…', decimals: 6, symbol: 'USDC' },          // any ERC-20
  amount: '0.05',
  payTo,
})

// On Solana, a custom SPL token is { mint, decimals }:
requirePayment({ chain: 'solana', token: { mint: '…', decimals: 6 }, amount: '0.05', payTo })

// On TON, a custom jetton is { master, decimals }:
requirePayment({ chain: 'ton', token: { master: 'EQ…', decimals: 6 }, amount: '0.05', payTo })

// On Stellar, a custom classic asset is { issuer, code, decimals }:
requirePayment({ chain: 'stellar', token: { issuer: 'G…', code: 'XYZ', decimals: 7 }, amount: '0.05', payTo })

// On the XRP Ledger, a custom issued currency is { issuer, currencyHex, decimals }:
requirePayment({ chain: 'xrpl', token: { issuer: 'r…', currencyHex: '5553444300000000000000000000000000000000', decimals: 6 }, amount: '0.05', payTo })

// On Tron, a custom TRC-20 is { address, decimals } (Base58 T… contract):
requirePayment({ chain: 'tron', token: { address: 'T…', decimals: 6 }, amount: '0.05', payTo })

// On NEAR, a custom NEP-141 is { contractId, decimals }:
requirePayment({ chain: 'near', token: { contractId: 'token.near', decimals: 6 }, amount: '0.05', payTo })

// On Sui, a custom coin is { coinType, decimals }:
requirePayment({ chain: 'sui', token: { coinType: '0x…::usdc::USDC', decimals: 6 }, amount: '0.05', payTo })

// On Aptos, a custom Fungible Asset is { metadata, decimals }:
requirePayment({ chain: 'aptos', token: { metadata: '0x…', decimals: 6 }, amount: '0.05', payTo })

// On Algorand, a custom ASA is { assetId, decimals }:
requirePayment({ chain: 'algorand', token: { assetId: 12345678, decimals: 6 }, amount: '0.05', payTo })
```

> **Production:** the built-in chains use public RPCs (rate-limited). Pass your own `rpcUrl` for real traffic.

## Solana

Solana works exactly like an EVM chain — just name it. The driver **auto-mounts** on first use (one lazy import), so pure-EVM installs never download the Solana libraries. The only step is installing the peer deps:

```bash
npm install @solana/web3.js @solana/spl-token bs58
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

// No setup call — naming the chain mounts the driver.
requirePayment({ chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourBase58Wallet…' })
new PipRailClient({ wallet: { secretKey: SOLANA_SECRET }, chain: 'solana' })
```

EVM wallets are `{ privateKey }` (or a viem `{ walletClient }`); Solana wallets are `{ secretKey }` (a `Uint8Array` or base58 string) or `{ signer }`. Mismatching a wallet or `payTo` to the wrong family throws a clear `WrongFamilyError` on first use.

## TON

TON (the Telegram blockchain) works the same way — name it. The driver **auto-mounts** on first use, so pure EVM/Solana installs never download the TON libraries. Install the peer deps:

```bash
npm install @ton/ton @ton/core @ton/crypto
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'ton', token: 'USDT', amount: '1', payTo: 'EQ…or UQ…' })
new PipRailClient({ wallet: { mnemonic: process.env.TON_MNEMONIC }, chain: 'ton' })
```

TON wallets are `{ mnemonic }` (24 words — a `string[]` or one space-separated string) or a ready `{ keyPair }`; add `version: 'v5r1'` for a W5 wallet (default is `v4`). USD₮ is built in (verified on-chain); native **USDC doesn't exist on TON**. Payments use [jettons](https://docs.ton.org/develop/dapps/asset-processing/jettons): the proof carries the gate's nonce as the transfer comment, so a TON proof is **bound to the challenge** that issued it, and verification reads the merchant's own jetton wallet — a look-alike jetton can't satisfy it. Note the payer needs a little **TON for gas** (~0.05) to send a jetton, on top of the USD₮.

## Tron

Tron is the single largest stablecoin-payment rail on earth (~45% of all USDT). Name it — the driver **auto-mounts** on first use, so other installs never download the Tron library. Install the peer dep:

```bash
npm install tronweb
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'tron', token: 'USDT', amount: '1', payTo: 'T…' })
new PipRailClient({ wallet: { privateKey: process.env.TRON_KEY }, chain: 'tron' })
```

Tron wallets are `{ privateKey }` (a 32-byte hex key — Tron uses secp256k1, like EVM). `payTo` is a Base58 `T…` address (an `0x…` address throws `WrongFamilyError`). **USD₮ (TRC-20) is built in, and native TRX is also supported** (`token: 'native'`, digest-bound) — native USDC doesn't exist on Tron (pass a custom `{ address, decimals }` for other TRC-20s). Verification is **digest-bound** (the proof is the txid): the merchant verifies the confirmed transfer on the **solidity node** (the finality gate) and the proof is single-use — so for multi-instance deployments use a persistent `isUsed`/`markUsed` store and keep `maxTimeoutSeconds` tight. The payer needs a little **TRX for energy/bandwidth** to send; receiving USDT needs no account setup.

## Stellar

Stellar is payment-native (~5s finality, sub-cent fees), with native Circle **USDC + EURC**. Name it `'stellar'` — the driver **auto-mounts** on first use. Install the peer dep:

```bash
npm install @stellar/stellar-sdk
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'stellar', token: 'USDC', amount: '0.05', payTo: 'G…' })
new PipRailClient({ wallet: { secret: process.env.STELLAR_SECRET }, chain: 'stellar' })
```

Stellar wallets are `{ secret }` (an `S…` secret seed) or a ready `{ keypair }` (a stellar-sdk `Keypair`); `payTo` is a `G…` account. USDC + EURC are built in (both Circle issuers verified live on Horizon mainnet); native XLM works with `token: 'native'`. Assets are **7-decimal**. The challenge nonce binds via the transaction **memo** — a `MEMO_HASH = sha256(nonce)` (Template A) — so a Stellar proof is **bound to its challenge**; verification reads the payment to `payTo` on Horizon and matches the memo hash, amount, and the asset's `CODE:ISSUER`. **To RECEIVE USDC/EURC the merchant account needs a one-time trustline** (`changeTrust` to the issuer) plus the XLM base reserve; native XLM needs neither.

## XRP Ledger

XRPL is payment-native (~3–5s finality), with native USDC + Ripple's RLUSD. Name it `'xrpl'` — the driver **auto-mounts** on first use. Install the peer dep:

```bash
npm install xrpl
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'xrpl', token: 'USDC', amount: '0.05', payTo: 'r…' })
new PipRailClient({ wallet: { seed: process.env.XRPL_SEED }, chain: 'xrpl' })
```

XRPL wallets are `{ seed }` (an `s…` secret seed) or a ready `{ wallet }` (an xrpl.js `Wallet`); `payTo` is a classic `r…` address. USDC + RLUSD are built in (both issuers verified live on mainnet); native XRP works with `token: 'native'`. The challenge nonce rides in a **Memo** (the cryptographic binding) plus a derived **DestinationTag** for deliverability, so an XRPL proof is **bound to its challenge**. Verification compares **`delivered_amount`** — what actually arrived — never `Amount`, which closes the `tfPartialPayment` attack. **To RECEIVE USDC/RLUSD the merchant account needs a one-time trustline** (`TrustSet`) plus the XRPL base reserve; native XRP needs neither.

## NEAR

NEAR is the "user-owned AI" chain (its co-founder co-authored the Transformer paper), with native USDC **and** USDT. Name it `'near'` — the driver **auto-mounts** on first use. Install the peer dep:

```bash
npm install near-api-js
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'near', token: 'USDC', amount: '0.05', payTo: 'merchant.near' })
new PipRailClient({ wallet: { accountId: 'agent.near', privateKey: process.env.NEAR_KEY }, chain: 'near' })
```

NEAR wallets are `{ accountId, privateKey }` (privateKey = an `ed25519:…` secret); `payTo` is a NEAR account id (`name.near` or a 64-hex implicit account). **Native NEAR is supported** (`token: 'native'`, 24dp) and is the **zero-setup** path — digest-bound (proof `<accountId>:<txHash>`, verified by tx hash + recency + single-use), needing **no `storage_deposit`**; a native transfer even *creates* a fresh implicit recipient. **Or pay in a token:** both USDC + USDT are native and built in (Circle's `17208628…`, Tether's `usdt.tether-token.near`) — the NEP-141 path is memo-bound (the nonce rides in the `ft_transfer` **`memo`**, verified by tx hash; verify only trusts an `ft_transfer` event from the real token contract), but **`storage_deposit` is required:** a recipient (and the payer) must be NEP-145-registered on that token once (~0.00125 NEAR) before it can receive/hold it, or `ft_transfer` panics. The payer needs a little **NEAR for gas** either way. (Never route through NEAR Intents/solvers — that re-adds a facilitator; plain transfers are what we do.)

## Sui

Sui is a Move L1 with sub-second finality + native Circle USDC (and protocol-level gasless stablecoin transfers). Name it `'sui'` — the driver **auto-mounts** on first use. Install the peer dep:

```bash
npm install @mysten/sui
```

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'sui', token: 'USDC', amount: '0.05', payTo: '0x…' })
new PipRailClient({ wallet: { privateKey: process.env.SUI_KEY }, chain: 'sui' })
```

Sui wallets are `{ privateKey }` (a `suiprivkey1…` bech32 secret) or a ready `{ keypair }` (an Ed25519Keypair); `payTo` is a Sui `0x…` address (32-byte). **USDC only** — no native USDT on Sui; native SUI works with `token: 'native'`. Verification is **digest-bound** (the proof is the tx digest, like EVM/Solana): the merchant reads the tx's balance changes — a positive change of the required coin type to `payTo` — and the proof is single-use, so for multi-instance deployments use a persistent `isUsed`/`markUsed` store and keep `maxTimeoutSeconds` tight. The driver ships the standard self-gas `Coin<USDC>` transfer (the payer needs a USDC coin object + a little SUI for gas); Sui's protocol-level **gasless** stablecoin path is a separate tx shape and a future enhancement — so this path isn't marketed as "gasless".

## How it works

```
Agent                                  Your server
  │  GET /report                            │
  │ ───────────────────────────────────────►│  requirePayment
  │ ◄──────────── 402 + payment-required ────│  (issues a challenge)
  │                                          │
  │  pay on-chain (one transfer to payTo)    │
  │ ───────────────────►  [the chain]        │
  │ ◄── proof (tx hash / signature) ─────     │
  │                                          │
  │  GET /report  + payment-signature        │
  │ ───────────────────────────────────────►│  verifies the tx against
  │ ◄──────────── 200 + your content ────────│  its own RPC, then next()
```

Verification is local and confirms the transaction **succeeded, is recent, and actually moved the required amount of the right token to `payTo`** — then your handler runs and returns the data. The same proof can't be redeemed twice. **Self-custody throughout:** the payer signs and broadcasts their own transfer straight to your wallet; PipRail never holds funds and never takes a cut of a payment.

It's a **pull** model: the caller hands you the exact tx ref in the `payment-signature` header, so `verify()` does a **targeted lookup on your own RPC** and answers **synchronously, in the same request** — no chain listener, no indexer, no accounts DB, no async notify. Why that matters vs. "just send a raw transfer" — with runnable proof and an honest scorecard — is laid out in [`examples/why-402/`](../examples/why-402/) (and the [root README](../README.md#-why-402-and-not-just-a-raw-transfer)).

## Receipts — record every payment

Every verified payment produces an `X402Receipt` with exactly what you'd persist — the on-chain tx ref, who paid, the amount, and the token. The SDK stays **database-free**; it hands you the data and you store it however you like.

```ts
// (1) The onPaid hook — fires on every settled payment.
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo,
  onPaid: (receipt) => db.payments.insert(receipt),
})

// (2) Or read it off the framework-agnostic gate result.
const r = await gate.verify(headerValue)
if (r.kind === 'paid') await db.payments.insert(r.receipt)
```

The receipt:

| Field | Example | Meaning |
|---|---|---|
| `transaction` | `0x9af…` · Solana signature · Sui digest | the on-chain transaction id |
| `payer` | `0x2b…` / `alice.near` | who paid |
| `payTo` | your wallet | who received |
| `asset` | USDC contract / coinType | token paid |
| `amount` | `50000` | amount, in base units |
| `network` | `eip155:8453` | which chain (CAIP-2) |
| `verifiedAt` | ISO timestamp | when the gate verified it |
| `scheme` | `'onchain-proof'` | settlement scheme (x402 v2) |
| `success` | `true` | settlement succeeded (always `true` — failures return a 402, never a receipt) |

On the payer side, the client surfaces the same receipt via the `payment-settled` event (`onEvent`) and `client.spent()` keeps a running per-asset ledger.

## Security model

What local verification guarantees, and what to know:

- **No third party.** The proof is a real on-chain transaction; your server checks it against your own RPC. Nothing is hosted in between and PipRail never holds funds.
- **Replay protection.** Each gate keeps an in-memory used-proof set, so one transaction can be redeemed once; a recency window (`maxTimeoutSeconds`, default 600s) rejects stale payments. Running multiple instances? Share the set with `isUsed` / `markUsed` (e.g. Redis `SET NX`).
- **Proof binding.** A proof is a public transaction hash, bound to *amount + token + `payTo` + recency* — not to the caller's identity. So **use a dedicated `payTo` per paid resource** (don't reuse a wallet that also receives unrelated transfers), and treat the recency window as the exposure bound. For contested or high-value endpoints where you need the proof cryptographically tied to the payer, open an issue — payer-bound proofs (the caller signs the challenge nonce with the paying key) are a planned opt-in.
- **Confirmations.** `minConfirmations` (default 1) gates access; raise it for higher-value payments on chains with cheaper reorgs.

## Any framework

`requirePayment` is Express/Connect middleware. For Hono, Fastify, Workers, Next.js, Bun, Deno — anything with `fetch` — build a gate and switch on the result:

```ts
import { createPaymentGate, toInvalidBody } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo })

export async function handler(req: Request): Promise<Response> {
  const r = await gate.verify(req.headers.get('payment-signature') ?? undefined)
  if (r.kind === 'paid')      return Response.json(data, { headers: { 'payment-response': r.receiptHeader } })
  if (r.kind === 'challenge') return Response.json(r.challenge, { status: 402, headers: { 'payment-required': r.requiredHeader } })
  return Response.json(toInvalidBody(r), { status: 402 }) // canonical 402 body on every adapter
}
```

Reuse one gate per route — its in-memory replay guard stops a proof being spent twice. Running multiple instances? Pass your own `isUsed` / `markUsed` (e.g. Redis `SET NX`).

## In the browser — no build, no npm

The SDK is browser-clean (no Node-only globals in the protocol layer), so a plain HTML page can take **or** make payments straight from a CDN — every npm-mirroring CDN serves it automatically:

```html
<script type="module">
  import { PipRailClient } from 'https://esm.sh/@piprail/sdk'   // or jsDelivr: .../npm/@piprail/sdk@1/+esm
  // In a browser, sign with the visitor's wallet — never a raw key (page source is public):
  import { createWalletClient, custom } from 'https://esm.sh/viem'
  const walletClient = createWalletClient({ transport: custom(window.ethereum) })

  const client = new PipRailClient({ chain: 'base', wallet: { walletClient } })
  const res = await client.fetch('https://api.example.com/paid')   // 402 → wallet signs → 200
</script>
```

- **Which chains run in the browser.** EVM (viem) works out of the box; **Solana, Sui, and NEAR** load their libs from the CDN too (an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) pins each to a browser-ESM build — see [`examples/browser/`](../examples/browser)). A few chains' libraries (**TON, Tron, XRPL, Stellar**) don't ship a clean browser ESM build yet, so use those **server-side** — the identical one line, on Node/Bun/Deno/Workers. The lazy import means a pure-EVM page never downloads any of them.
- **The merchant gate runs anywhere.** `createPaymentGate` needs only a `payTo` address — no key — so building challenges and verifying proofs works in the browser too (the typical *deployment* is still a server, since a browser can't receive inbound HTTP to gate).
- **Both halves verified on Node and in a real browser**, against the published package. Runnable showcase: [`examples/browser/`](../examples/browser) — a single HTML file with a live, in-browser 402 demo; or try it hosted at [piprail.com/demo](https://piprail.com/demo).
- **Keys:** raw `{ privateKey }` wallets belong only in a **server's** environment. In a browser, use an injected `walletClient` as above.

## Architecture (under the hood)

Two layers, one contract. Worth knowing if you're extending the SDK or auditing it.

- **The protocol layer is chain-agnostic.** `server.ts` (`requirePayment`/`createPaymentGate`), `client.ts` (`PipRailClient`), `x402.ts` (wire envelopes), `policy.ts`, `ledger.ts`, and `agent.ts` depend **only** on the `PaymentDriver` contract in `drivers/types.ts` — zero `viem`, zero `@solana/web3.js`, zero chain SDK. The chain is data the caller passes, not an allowlist the SDK ships.
- **The `PaymentDriver` contract.** `resolve(chain)` → a bound `ResolvedNetwork` exposing `resolveToken` · `describeAsset` · `assertValidPayTo` · `bindWallet` · `send` · `confirm` · `estimateCost` · `balanceOf` · `recipientReady` · `verify`. That's the entire boundary every family implements and the protocol layer ever sees.
- **Families mirror each other file-for-file.** Each lives in `drivers/<family>/` as `chains` · `wallet` · `pay` · `verify` · `index`, with family-suffixed functions (`payEvm`/`paySui`/…, `verifyEvm`/`verifyNear`/…). Ten today: `evm`, `solana`, `ton`, `stellar`, `xrpl`, `tron`, `near`, `sui`, `aptos`, `algorand`. Adding one = copy the five files, implement the contract, `registerDriver` — the protocol layer never changes.
- **Routing + lazy auto-mount.** `registry.ts` maps a `chain` value to its family synchronously (`familyForChain`). EVM is always present (viem is a hard peer); every non-EVM family **loads itself on first use** via one dynamic `import()`, so a pure-EVM install never downloads `@solana`/`@ton`/`@stellar`/`xrpl`/`tronweb`/`near-api-js`/`@mysten/sui`/`@aptos-labs/ts-sdk`/`algosdk`. A build-time invariant asserts the main bundle has **zero** static imports of those libs — only per-family lazy chunks.
- **Two verification templates.** *Template A (memo-bound)* — Stellar, XRPL, TON, NEAR, Algorand — carries the challenge nonce inside the transfer (memo / tag / comment / note), so the proof is cryptographically bound to its challenge. *Template B (digest-bound)* — EVM, Solana, Tron, Sui, Aptos — binds via a single-use proof set + recipient + amount + a tight recency window (use a persistent `isUsed`/`markUsed` store in production).
- **Gas estimation.** Every driver's `estimateCost` extracts its own per-chain fee math, shaped into one uniform `CostEstimate` by the shared `nativeCost()` helper (`util/cost.ts`).
- **The tests are the contract** (`test/`, Vitest), and two living standards govern any change: **[ERRORS.md](./ERRORS.md)** (how every module reports errors) and **STANDARDS.md** (how anything in the SDK is built + the verification gate). Runnable examples — including a local Anvil end-to-end — live in [`examples/`](../examples).

## Errors

Every failure is **typed and understandable** — never a raw chain-library blob. Two channels:

- **Thrown** — a `PipRailError` subclass with a stable `.code` (`INSUFFICIENT_FUNDS`, `RECIPIENT_NOT_READY`, `WRONG_FAMILY`, `UNKNOWN_TOKEN`, `CONFIRMATION_TIMEOUT`, `MAX_RETRIES_EXCEEDED`, `PAYMENT_DECLINED`, …). Catch with `err instanceof PipRailError` or branch on `err.code`. Affordability always surfaces as one `InsufficientFundsError`, on every chain. A `policy`/`onBeforePay` refusal is `PaymentDeclinedError`, thrown before any send.
- **Returned** — server-side `verify()` rejects a proof with a `VerifyErrorCode` (`amount_too_low`, `transfer_not_found`, `payment_expired`, `tx_reverted`, …). The gate emits a 402 body `{ x402Version: 2, status: 'invalid', error, detail }` (build it with `toInvalidBody`), and the client relays the reason — so a rejected agent learns *why* (`MaxRetriesExceededError: … amount_too_low — Paid 40000, required 500000`).

### "Why did my payment fail?" — payer vs. recipient

A failed payment is almost always one of two things, and PipRail tells them apart so a human **or an AI agent** knows exactly what to fix — never an opaque `tecNO_DST_INSUF_XRP`:

- **`INSUFFICIENT_FUNDS`** → the **payer** can't cover it. Fund the payer (more token, native gas, or the chain's reserve).
- **`RECIPIENT_NOT_READY`** → the **recipient** isn't set up to receive *on this chain yet*. This is a **chain requirement, not an SDK bug** — most chains gate receiving behind some one-time state. Every such message says what's needed and the fix, **echoes the raw chain code** (e.g. `(XRPL: tecNO_DST_INSUF_XRP)`), and keeps the untouched chain error on `err.cause` for debugging.

**What each chain needs to *receive* (and who sets it up):**

| Chain | The recipient must… | Sender also needs |
|---|---|---|
| **EVM · Solana · Sui · Aptos · Tron** | nothing (just be a valid address; Solana's token account is auto-created by the SDK; Aptos's primary FA store auto-creates) | native gas |
| **TON** | nothing for native; a jetton wallet auto-deploys on first receipt (sender pays the gas) | TON for gas |
| **NEAR** | nothing for native; for a token, be `storage_deposit`-registered on it (NEP-145, ~0.00125 NEAR, one-time) | NEAR for gas |
| **Stellar** | exist (created with ≥1 XLM base reserve); for USDC/EURC, hold a **trustline** (+0.5 XLM each) | base + trustline reserves |
| **XRP Ledger** | be **activated** — hold ≥1 XRP base reserve to exist; for USDC/RLUSD, a **trustline** | keep its own 1 XRP reserve |
| **Algorand** | nothing for native ALGO; for USDC, **opt into the ASA** once (a 0-amount self-transfer, ~0.1 ALGO min-balance bump) | ALGO for fees + its own opt-in |

> These are anti-spam "state rent" rules built into each ledger — e.g. an XRPL account can't receive a sub-1-XRP first payment because that payment must create the account at its ≥1 XRP base reserve. PipRail surfaces them as `RECIPIENT_NOT_READY` with the fix, so a payment that "can't go through" is self-explanatory. Per-chain specifics live in **[CHAINS.md](./CHAINS.md)**.

### Flaky RPC? No false unlocks, no double-pays

Public RPCs are rate-limited, so reads sometimes fail *after* a transaction is already on-chain. PipRail is built so that never costs you money or a leaked unlock:

- **The merchant never unlocks without a real payment.** If the gate's verification read fails, it returns `tx_not_found` → **402 (locked)**, never `paid`. Verification *fails closed* — an RPC outage can't be exploited to get free access. And the gate **releases the replay claim** on failure, so the payer can re-submit the *same* proof once the RPC recovers (the proof isn't burned).
- **The payer never loses a broadcast payment.** If the transfer broadcasts but the client's own confirmation times out (a throttled RPC that lands the tx but 429s the status read), the client does **not** throw the proof away — it emits a `payment-unconfirmed` event, submits the proof to the server (the on-chain authority) with more patient retries, and **never re-broadcasts**. If it still can't confirm, it throws `MaxRetriesExceededError` / `PaymentTimeoutError` carrying **`.ref`**.

> **Agent recovery rule:** on `MAX_RETRIES_EXCEEDED` / `PAYMENT_TIMEOUT`, read `err.ref` and **re-verify or re-submit that proof — never re-pay** (a fresh payment double-spends). The proof stays redeemable until the gate's `maxTimeoutSeconds` window (default 600s). The real fix for repeated lag is a dedicated `rpcUrl` (per chain in multi-accept) instead of the public default.

The full standard every module follows is **[ERRORS.md](./ERRORS.md)**.

## API

**`requirePayment(options)`** → Express middleware &nbsp;·&nbsp; **`createPaymentGate(options)`** → `{ challenge, verify, describe }` (`describe()` → static discovery metadata for the emitters)

| Option | Default | Notes |
|---|---|---|
| `chain` | — | `'base'` / `'bnb'` / `'solana'` / `'ton'` / …, a viem `Chain`, or `{ id, rpcUrl }` (single-chain form) |
| `amount` | — | Human-readable, e.g. `'0.05'` (single-chain form) |
| `token` | — | `'USDC'` / `'USDT'`, `'native'`, or a custom `{ address, decimals }` (EVM/Tron) / `{ mint, decimals }` (Solana) / `{ master, decimals }` (TON) / `{ issuer, code, decimals }` (Stellar) / `{ issuer, currencyHex, decimals }` (XRPL) / `{ contractId, decimals }` (NEAR) / `{ coinType, decimals }` (Sui) / `{ metadata, decimals }` (Aptos) / `{ assetId, decimals }` (Algorand) — required for the single form |
| `accept` | — | Multi-chain form: `[{ chain, token, amount, payTo?, rpcUrl? }, …]` — offer several chains in one challenge |
| `payTo` | — | Wallet that receives the payment (per-option fallback in the multi form) |
| `description` | — | Optional text shown to the agent in the challenge (what the payment is for) |
| `rpcUrl` | chain default | Your own RPC (recommended in production) |
| `minConfirmations` | `1` | Confirmations before access is granted |
| `maxTimeoutSeconds` | `600` | Reject payments older than this (replay window) |
| `onPaid` | — | `(receipt) => void` on a verified payment (see [Receipts](#receipts--record-every-payment)) |
| `isUsed` / `markUsed` | in-memory | Replay store hooks — share across instances (e.g. Redis `SET NX`) |
| `generateNonce` | `crypto.randomUUID()` | Custom per-challenge nonce generator |
| `exact` | — | Opt in to **also** advertise a standard x402 `exact` rail (EIP-3009) so any standard client can pay: `{ settle: 'self', relayer: { privateKey } }` (your relayer broadcasts) or `{ settle: { facilitator } }` (delegate to a chosen facilitator). EVM + USDC/EURC only — see [Universal payments](#universal-payments--get-paid-by-any-x402-client) |

Provide **either** `chain` + `token` + `amount` (single) **or** a non-empty `accept` array (multi) — not both.

**`new PipRailClient({ wallet, chain, rpcUrl?, policy?, onBeforePay?, maxPaymentRetries?, retryTimeoutMs?, onEvent? })`**

| Option | Default | Notes |
|---|---|---|
| `wallet` | — | Keys for the chosen family (see the wallet table below) |
| `chain` | — | Which chain to pay on — same selector as the gate |
| `rpcUrl` | chain default | Your own RPC (recommended in production) |
| `policy` | — | Spend guardrails: `maxAmount`, `maxTotal` (per token), `chains`, `tokens`, `hosts`, `allowUnknownTokens`. Over-limit → `PaymentDeclinedError` before any send |
| `onBeforePay` | — | `(quote) => boolean \| Promise<boolean>` — final approval per payment; `false`/throw declines |
| `maxPaymentRetries` | `3` | Re-sends with proof after paying (absorbs RPC propagation lag) |
| `retryTimeoutMs` | `30000` | Timeout for the retry leg after broadcast |
| `onEvent` | — | `(event) => void` observability: `payment-required` · `payment-broadcast` · `payment-confirmed` · `payment-unconfirmed` (broadcast OK, local confirm timed out → deferring to server) · `payment-settled` · `payment-failed` |

Methods: `fetch` · `get` · `post` (return the gated `Response` after settlement) · **`quote(url)`** (price without paying → `PipRailQuote \| null`) · **`estimateCost(url)`** (price **+** native-coin gas estimate → `PipRailCostQuote \| null`) · **`planPayment(url)`** (affordability + recipient-readiness across the offered rails → `PaymentPlan \| null`) · **`canAfford(url)`** (→ `boolean`) · **`spent()`** (per-asset ledger snapshot) · **`discover(opts?)`** (find resources on the open indexes → `DiscoveredResource[]`) · **`register(url, opts?)`** (list a resource on the open indexes → `RegisterOutcome[]`) · **`discoverySigner()`** (the wallet's discovery signer, EVM today, or `null`). Pass `{ autoRoute: true }` to `fetch` (or set it on the client) to pay the cheapest *settleable* rail. Module-level **`planAcross(clients, url)`** plans across chains.

**Discovery (opt-in, $0, nothing hosted):** `client.discover()` / `client.register()`, the standalone `searchOpenIndexes` / `register402Index` / `registerX402Scan`, and the pure emitters `buildOpenApi` / `buildWellKnownX402` / `buildX402DnsTxt` (fed by `gate.describe()`). See [Be discoverable](#be-discoverable--find-and-be-found-0-no-backend).

**Wallets by family** — the `chain` selector routes; each driver validates its own key format (a mismatch throws `WrongFamilyError`):

| Family | `wallet` shape |
|---|---|
| EVM | `{ privateKey }` (0x… hex) or a viem `{ walletClient }` |
| Solana | `{ secretKey }` (Uint8Array or base58) or `{ signer }` |
| TON | `{ mnemonic }` (24 words) or `{ keyPair }` (+ `version: 'v5r1'` for W5) |
| Stellar | `{ secret }` (S… seed) or `{ keypair }` |
| XRPL | `{ seed }` (s… seed) or `{ wallet }` |
| Tron | `{ privateKey }` (32-byte hex — secp256k1) |
| NEAR | `{ accountId, privateKey }` (privateKey = ed25519:… secret) |
| Sui | `{ privateKey }` (suiprivkey1… bech32) or `{ keypair }` |
| Aptos | `{ privateKey }` (ed25519-priv-0x… AIP-80) or `{ account }` |
| Algorand | `{ mnemonic }` (25 words) or `{ account }` (algosdk `{ addr, sk }`) |

**Hand an LLM a wallet:** `paymentTools(client)` → five framework-agnostic tool descriptors (`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · `piprail_pay_request` · `piprail_register`) for MCP / AI SDK / function-calling, budget enforced by the client.

**Bring your own chain family:** the SDK is built on a tiny `PaymentDriver` contract — `resolve(chain)` returns a bound network with `resolveToken` / `describeAsset` / `assertValidPayTo` / `bindWallet` / `send` / `confirm` / `estimateCost` / `balanceOf` / `recipientReady` / `verify`. Register your own with `registerDriver(...)`; the protocol layer never changes (see [Architecture](#architecture-under-the-hood)).

**Universal x402 (experimental):** building blocks to pay servers on the mainstream x402 `exact` scheme (EIP-3009 + facilitator) — `parseExactRequirements`, `buildExactAuthorization`, `encodeXPaymentHeader`. EVM-only; validate against your target facilitator before production.

## Requirements

- Node 20+ or a modern browser.
- `viem ^2.21` (peer dep). Solana: `@solana/web3.js`, `@solana/spl-token`, `bs58` (optional peers). TON: `@ton/ton`, `@ton/core`, `@ton/crypto` (optional peers). Stellar: `@stellar/stellar-sdk` (optional peer). XRPL: `xrpl` (optional peer). Tron: `tronweb` (optional peer). NEAR: `near-api-js` (optional peer). Sui: `@mysten/sui` (optional peer). Aptos: `@aptos-labs/ts-sdk` (optional peer). Algorand: `algosdk` (optional peer).

## License & trademark

The code is **MIT** — use it, fork it, ship it. **PipRail™**, the logo, and the `@piprail` npm scope are trademarks of the PipRail project: build on the code freely, but please don't call a fork "PipRail" or imply it's official. See [TRADEMARK.md](https://github.com/piprail/piprail/blob/main/TRADEMARK.md).
