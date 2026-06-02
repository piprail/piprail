# @piprail/sdk

**Accept crypto payments from any HTTP request — on any EVM chain, Solana, TON, Tron, NEAR, Sui, Stellar, and the XRP Ledger — in a couple of lines.**

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
    tokens: ['USDC'],         // only in USDC
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

**Know the gas before you pay.** `client.estimateCost(url)` returns the quote **and** a `CostEstimate` — the network fee in the chain's **native coin** (you pay in USDC but burn ETH / SOL / TON / XLM / XRP / TRX on gas, a separate balance the agent must keep topped up). It's best-effort and labelled (`cost.basis`): a live-RPC read where cheap (`'estimated'` — EVM gas price, XRPL fee), a typical-cost constant otherwise (`'heuristic'`), and it never throws. Most valuable on **Tron**, where a USD₮ transfer can cost real TRX. So an agent can budget the *total* — payment **+** gas — before any funds move. Every driver implements it; the math is extracted per-chain and shaped uniformly by one shared `nativeCost()` helper.

### Hand an LLM a budget-bound wallet

`paymentTools(client)` returns framework-agnostic tool descriptors (name + description + JSON Schema + `invoke`) — drop them into MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling, or LangChain in a couple of lines. The budget rides on the client, so the model can't overspend.

```ts
import { paymentTools } from '@piprail/sdk'
const tools = paymentTools(client) // → [piprail_quote_payment, piprail_pay_request]
```

See [`examples/agent-tools.mjs`](../examples/agent-tools.mjs) for MCP / AI-SDK wiring.

### Accept several chains at once

`requirePayment` (and `createPaymentGate`) take an **`accept: [...]`** array — one challenge that's payable on **any** of several chains/tokens, across **all eight families** (EVM, Solana, TON, Tron, Stellar, XRPL, NEAR, Sui). The agent pays with whatever it holds:

```ts
requirePayment({
  accept: [
    { chain: 'base',   token: 'USDC', amount: '0.05', payTo: '0xYourEvmWallet…' },
    { chain: 'tron',   token: 'USDT', amount: '0.05', payTo: 'TYourTronWallet…' },
    { chain: 'xrpl',   token: 'USDC', amount: '0.05', payTo: 'rYourXrplWallet…' },
    { chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourSolWallet…' },
  ],
})
```

How the multi-chain case is handled, end-to-end:

- **Gate:** each option resolves through its own driver (its `payTo` is validated and its token resolved) and is listed in the challenge's `accepts[]`, sharing one nonce. `payTo` falls back to the top-level `payTo` when omitted — but address shapes differ per family, so give a per-option `payTo` for each non-EVM chain.
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

**Native or stablecoin — your choice, on most chains.** Every gate accepts the chain's native coin (ETH, BNB, POL, AVAX, SOL, TON, XLM, XRP, SUI, …) just as readily as a stablecoin — set `token: 'native'` and the SDK fills in the right decimals (18 on EVM, 9 on Solana/TON/Sui, 7 on Stellar, 6 on XRPL). Verification, replay protection, and self-custody are identical to the stablecoin path. (**Two exceptions — token-only chains:** **Tron** is TRC-20-only and **NEAR** is NEP-141-only; both ship USDC/USDT but their native coin isn't a payment asset — a Tron/NEAR token transfer is what binds + verifies.)

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
| `'solana'` | Solana | USDC, USDT |
| `'ton'` | TON | USDT |
| `'tron'` | Tron | USDT |
| `'near'` | NEAR | USDC, USDT |
| `'sui'` | Sui | USDC |
| `'stellar'` | Stellar | USDC, EURC |
| `'xrpl'` | XRP Ledger | USDC, RLUSD |

**TON note:** native **USDC does not exist on TON** (Circle doesn't issue it there) — so it's intentionally absent. USD₮ (Tether) is native and built in; for USDe / bridged tokens pass a custom jetton (below).

**Tron note:** native **USDC doesn't exist on Tron either** (Circle discontinued it; the only USDC there is a third-party bridge) — so it's intentionally absent. USD₮ (TRC-20) is native and built in. Tron is **TRC-20 only**: native TRX isn't a payment asset (pass USDT or a custom TRC-20).

**NEAR note:** ships **both native USDC + USDT** (Circle's native USDC `17208628…`, NOT the bridged `…factory.bridge.near`; Tether's native `usdt.tether-token.near`). NEAR is **NEP-141 only** — native NEAR isn't a payment asset (its transfer carries no memo to bind). A recipient must be **`storage_deposit`-registered** on the token once before it can receive (see the NEAR section).

**Sui note:** **USDC only** — no native USDT on Sui (Wormhole-bridged only). Native SUI works with `token: 'native'`.

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

Tron wallets are `{ privateKey }` (a 32-byte hex key — Tron uses secp256k1, like EVM). `payTo` is a Base58 `T…` address (an `0x…` address throws `WrongFamilyError`). **USD₮ (TRC-20) is built in; Tron is TRC-20 only** — native USDC doesn't exist there, and native TRX isn't a payment asset (pass USDT or a custom `{ address, decimals }`). Verification is **digest-bound** (the proof is the txid): the merchant verifies the confirmed transfer on the **solidity node** (the finality gate) and the proof is single-use — so for multi-instance deployments use a persistent `isUsed`/`markUsed` store and keep `maxTimeoutSeconds` tight. The payer needs a little **TRX for energy/bandwidth** to send; receiving USDT needs no account setup.

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

NEAR wallets are `{ accountId, privateKey }` (privateKey = an `ed25519:…` secret); `payTo` is a NEAR account id (`name.near` or a 64-hex implicit account). **Both USDC + USDT are native and built in** (Circle's `17208628…`, Tether's `usdt.tether-token.near`); NEAR is **NEP-141 only** — native NEAR isn't a payment asset. The challenge nonce rides in the NEP-141 `ft_transfer` **`memo`** (Template A binding) and is verified by tx hash (NEAR has no account-history RPC): the proof is `<accountId>:<txHash>`, and verify only trusts an `ft_transfer` event emitted by the real token contract (provenance). **`storage_deposit` (real):** a recipient must be NEP-145-registered on the token once (~0.00125 NEAR) before it can receive, or `ft_transfer` panics — register `payTo` out of band. The payer needs a little **NEAR for gas** + the mandatory 1 yoctoNEAR per transfer. (Never route through NEAR Intents/solvers — that re-adds a facilitator; a plain `ft_transfer` is what we do.)

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

## Architecture (under the hood)

Two layers, one contract. Worth knowing if you're extending the SDK or auditing it.

- **The protocol layer is chain-agnostic.** `server.ts` (`requirePayment`/`createPaymentGate`), `client.ts` (`PipRailClient`), `x402.ts` (wire envelopes), `policy.ts`, `ledger.ts`, and `agent.ts` depend **only** on the `PaymentDriver` contract in `drivers/types.ts` — zero `viem`, zero `@solana/web3.js`, zero chain SDK. The chain is data the caller passes, not an allowlist the SDK ships.
- **The `PaymentDriver` contract.** `resolve(chain)` → a bound `ResolvedNetwork` exposing `resolveToken` · `describeAsset` · `assertValidPayTo` · `bindWallet` · `send` · `confirm` · `estimateCost` · `verify`. That's the entire boundary every family implements and the protocol layer ever sees.
- **Families mirror each other file-for-file.** Each lives in `drivers/<family>/` as `chains` · `wallet` · `pay` · `verify` · `index`, with family-suffixed functions (`payEvm`/`paySui`/…, `verifyEvm`/`verifyNear`/…). Eight today: `evm`, `solana`, `ton`, `stellar`, `xrpl`, `tron`, `near`, `sui`. Adding one = copy the five files, implement the contract, `registerDriver` — the protocol layer never changes.
- **Routing + lazy auto-mount.** `registry.ts` maps a `chain` value to its family synchronously (`familyForChain`). EVM is always present (viem is a hard peer); every non-EVM family **loads itself on first use** via one dynamic `import()`, so a pure-EVM install never downloads `@solana`/`@ton`/`@stellar`/`xrpl`/`tronweb`/`near-api-js`/`@mysten/sui`. A build-time invariant asserts the main bundle has **zero** static imports of those libs — only per-family lazy chunks.
- **Two verification templates.** *Template A (memo-bound)* — Stellar, XRPL, TON, NEAR — carries the challenge nonce inside the transfer (memo / tag / comment), so the proof is cryptographically bound to its challenge. *Template B (digest-bound)* — EVM, Solana, Tron, Sui — binds via a single-use proof set + recipient + amount + a tight recency window (use a persistent `isUsed`/`markUsed` store in production).
- **Gas estimation.** Every driver's `estimateCost` extracts its own per-chain fee math, shaped into one uniform `CostEstimate` by the shared `nativeCost()` helper (`util/cost.ts`).
- **The tests are the contract** (`test/`, Vitest), and two living standards govern any change: **[ERRORS.md](./ERRORS.md)** (how every module reports errors) and **STANDARDS.md** (how anything in the SDK is built + the verification gate). Runnable examples — including a local Anvil end-to-end — live in [`examples/`](../examples).

## Errors

Every failure is **typed and understandable** — never a raw chain-library blob. Two channels:

- **Thrown** — a `PipRailError` subclass with a stable `.code` (`INSUFFICIENT_FUNDS`, `WRONG_FAMILY`, `UNKNOWN_TOKEN`, `CONFIRMATION_TIMEOUT`, `MAX_RETRIES_EXCEEDED`, `PAYMENT_DECLINED`, …). Catch with `err instanceof PipRailError` or branch on `err.code`. Affordability always surfaces as one `InsufficientFundsError`, on every chain. A `policy`/`onBeforePay` refusal is `PaymentDeclinedError`, thrown before any send.
- **Returned** — server-side `verify()` rejects a proof with a `VerifyErrorCode` (`amount_too_low`, `transfer_not_found`, `payment_expired`, `tx_reverted`, …). The gate emits a 402 body `{ x402Version: 2, status: 'invalid', error, detail }` (build it with `toInvalidBody`), and the client relays the reason — so a rejected agent learns *why* (`MaxRetriesExceededError: … amount_too_low — Paid 40000, required 500000`).

The full standard every module follows is **[ERRORS.md](./ERRORS.md)**.

## API

**`requirePayment(options)`** → Express middleware &nbsp;·&nbsp; **`createPaymentGate(options)`** → `{ challenge, verify }`

| Option | Default | Notes |
|---|---|---|
| `chain` | — | `'base'` / `'bnb'` / `'solana'` / `'ton'` / …, a viem `Chain`, or `{ id, rpcUrl }` (single-chain form) |
| `amount` | — | Human-readable, e.g. `'0.05'` (single-chain form) |
| `token` | — | `'USDC'` / `'USDT'`, `'native'`, or a custom `{ address, decimals }` (EVM/Tron) / `{ mint, decimals }` (Solana) / `{ master, decimals }` (TON) / `{ issuer, code, decimals }` (Stellar) / `{ issuer, currencyHex, decimals }` (XRPL) / `{ contractId, decimals }` (NEAR) / `{ coinType, decimals }` (Sui) — required for the single form |
| `accept` | — | Multi-chain form: `[{ chain, token, amount, payTo?, rpcUrl? }, …]` — offer several chains in one challenge |
| `payTo` | — | Wallet that receives the payment (per-option fallback in the multi form) |
| `description` | — | Optional text shown to the agent in the challenge (what the payment is for) |
| `rpcUrl` | chain default | Your own RPC (recommended in production) |
| `minConfirmations` | `1` | Confirmations before access is granted |
| `maxTimeoutSeconds` | `600` | Reject payments older than this (replay window) |
| `onPaid` | — | `(receipt) => void` on a verified payment (see [Receipts](#receipts--record-every-payment)) |
| `isUsed` / `markUsed` | in-memory | Replay store hooks — share across instances (e.g. Redis `SET NX`) |
| `generateNonce` | `crypto.randomUUID()` | Custom per-challenge nonce generator |

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
| `onEvent` | — | `(event) => void` observability: `payment-required` · `payment-broadcast` · `payment-confirmed` · `payment-settled` · `payment-failed` |

Methods: `fetch` · `get` · `post` (return the gated `Response` after settlement) · **`quote(url)`** (price without paying → `PipRailQuote \| null`) · **`estimateCost(url)`** (price **+** native-coin gas estimate → `PipRailCostQuote \| null`) · **`spent()`** (per-asset ledger snapshot).

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

**Hand an LLM a wallet:** `paymentTools(client)` → framework-agnostic tool descriptors (MCP / AI SDK / function-calling), budget enforced by the client.

**Bring your own chain family:** the SDK is built on a tiny `PaymentDriver` contract — `resolve(chain)` returns a bound network with `resolveToken` / `describeAsset` / `assertValidPayTo` / `bindWallet` / `send` / `confirm` / `estimateCost` / `verify`. Register your own with `registerDriver(...)`; the protocol layer never changes (see [Architecture](#architecture-under-the-hood)).

**Universal x402 (experimental):** building blocks to pay servers on the mainstream x402 `exact` scheme (EIP-3009 + facilitator) — `parseExactRequirements`, `buildExactAuthorization`, `encodeXPaymentHeader`. EVM-only; validate against your target facilitator before production.

## Requirements

- Node 20+ or a modern browser.
- `viem ^2.21` (peer dep). Solana: `@solana/web3.js`, `@solana/spl-token`, `bs58` (optional peers). TON: `@ton/ton`, `@ton/core`, `@ton/crypto` (optional peers). Stellar: `@stellar/stellar-sdk` (optional peer). XRPL: `xrpl` (optional peer). Tron: `tronweb` (optional peer). NEAR: `near-api-js` (optional peer). Sui: `@mysten/sui` (optional peer).

## License & trademark

The code is **MIT** — use it, fork it, ship it. **PipRail™**, the logo, and the `@piprail` npm scope are trademarks of the PipRail project: build on the code freely, but please don't call a fork "PipRail" or imply it's official. See [TRADEMARK.md](https://github.com/piprail/piprail/blob/main/TRADEMARK.md).
