# Changelog

All notable changes to `@piprail/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-02

The multi-chain rewrite and first stable release. **24 chains across 8 families**
(17 EVM + Solana, TON, Tron, NEAR, Sui, Stellar, XRPL), plus agent spend controls,
a gas/cost estimator, and an agent toolkit — one parameter still picks everything.
Everything below is **opt-in**; the zero-config client and gate are unchanged.

> The earlier 0.1.x–0.2.0 preview line (single-chain) has been withdrawn from npm;
> `npm install @piprail/sdk` now resolves to 1.0.0.

### Agent spend controls (client)
- **`policy`** on `PipRailClient` — `maxAmount` (per call) + `maxTotal` (lifetime,
  per token) ceilings and `chains` / `tokens` / `hosts` allowlists. A 402 outside
  the policy is refused with the new **`PaymentDeclinedError`** (`PAYMENT_DECLINED`)
  **before any on-chain send**. Caps are enforced against the token's **true**
  decimals (via the new driver `describeAsset`), so a server can't understate a price.
- **`client.quote(url)`** — learn the price of a gated URL **without paying** (returns
  a `PipRailQuote`, or `null` when the URL isn't gated). Flags a `symbolMismatch` when
  a challenge's stated symbol disagrees with the real token.
- **`onBeforePay(quote)`** — a final approval hook per payment; returning `false`
  (or throwing) declines without paying.
- **`client.spent()`** — an in-memory ledger snapshot, aggregated per token.

### Multi-chain accepts (gate)
- `requirePayment` / `createPaymentGate` accept an **`accept: [{ chain, token, amount,
  payTo? }, …]`** array — one challenge offers several chains, and the agent pays with
  whatever it holds. `verify()` re-derives every checked field from the server's own
  requirement for the claimed network (a forged echo can't redirect it). The legacy
  single-chain form is unchanged.

### Agent toolkit
- **`paymentTools(client)`** — framework-agnostic tool descriptors (name + description +
  JSON Schema + `invoke`) for MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling,
  or LangChain. The client's budget rides along, so the model can't overspend.

### x402 `exact`-scheme interop (experimental, EVM)
- Building blocks to pay servers on the mainstream x402 `exact` scheme (EIP-3009 +
  facilitator): `parseExactRequirements`, `buildExactAuthorization`,
  `encodeXPaymentHeader`, `chainIdForExactNetwork`. Not wired into the default client
  flow — hand-roll with these and validate against your target facilitator.

### Gas / cost estimator
- **`client.estimateCost(url)`** — learn the **network fee (gas)** to pay a gated URL,
  WITHOUT paying. Returns a `PipRailCostQuote` (`{ quote, cost }`): the payment quote
  plus a `CostEstimate` — the fee in the chain's **native coin** (you pay USDC but burn
  ETH/SOL/TON/XLM/XRP/TRX on gas, a separate balance). Best-effort + labelled (`cost.basis`):
  live-RPC where cheap (`'estimated'`), a typical-cost constant otherwise (`'heuristic'`);
  never throws. So an agent budgets the *total* — payment + gas — before any funds move.
  Most valuable on Tron, where a USD₮ transfer costs real TRX.
- New driver-contract method **`estimateCost(accept, opts?)`** (required), implemented across
  all eight families. The per-chain fee math (EVM gas × price, Solana lamports, Tron energy ×
  price via `triggerConstantContract`, XRPL drops, …) is extracted in each driver and shaped
  uniformly by one shared `nativeCost()` helper (`util/cost.ts`). `opts.from` sharpens
  sender-dependent fees (Tron energy).
- `WalletInput` now includes XRPL's `{ seed }` / `{ wallet }` and documents Tron's
  `{ privateKey }`, so every built-in family is type-correct on `PipRailClient`.

### Driver contract
- Added **`describeAsset(asset)`** to `ResolvedNetwork` (trusted decimals/symbol for a
  known asset, or `null`), implemented across EVM/Solana/TON/Stellar/XRPL/Tron/NEAR/Sui.

### Chains
- Now **24 chains built in** (17 EVM + Solana + TON + Tron + NEAR + Sui + Stellar + XRPL).
  Beyond 0.1.0's set, this cycle added the **Sei** + **Injective** EVM presets, **Stellar**,
  **Tron**, the **XRP Ledger**, and now **NEAR** and **Sui**. One parameter still picks
  everything; the non-EVM families auto-mount on first use (pure-EVM installs never
  download their libs).
- **NEAR** (`chain: 'near'`, optional peer `near-api-js`) — the "user-owned AI" chain, with
  **both native USDC + USDT** (`ft_metadata`-verified; Circle's `17208628…` and Tether's
  `usdt.tether-token.near`, NOT bridged). Template A binding (nonce in the NEP-141
  `ft_transfer` memo) **verified by tx hash** — proof ref `<accountId>:<txHash>`, and only an
  ft_transfer event from the trusted token contract counts (provenance). **NEP-141 only**
  (native NEAR isn't a payment asset); recipients need a one-time NEP-145 `storage_deposit`.
  Wallets are `{ accountId, privateKey }`; custom NEP-141 via `{ contractId, decimals }`.
- **Sui** (`chain: 'sui'`, optional peer `@mysten/sui` v2 — `SuiJsonRpcClient`) — Move L1, sub-second finality, native
  Circle **USDC** (`suix_getCoinMetadata`-verified; no native USDT on Sui). Template B
  (digest-bound): the proof is the tx digest, verified via balance changes + single-use.
  Ships the standard self-gas `Coin<USDC>` transfer; Sui's protocol-level **gasless** stablecoin
  path (no sponsor/relayer) is a documented future enhancement, not claimed on this path.
  Wallets are `{ privateKey }` (suiprivkey1…) or `{ keypair }`; custom coins via `{ coinType, decimals }`.
- **Tron** (`chain: 'tron'`, optional peer `tronweb`) — the largest USDT rail (~45% of
  all USDT). Ships **USD₮ (TRC-20) only** — native USDC doesn't exist on Tron, and it's
  **TRC-20 only** (native TRX isn't a payment asset). Digest-bound (Template B): the
  proof is the txid, verified on the **solidity/confirmed node** and single-use. Wallets
  are `{ privateKey }`; custom TRC-20 via `{ address, decimals }`.
- **XRP Ledger** (`chain: 'xrpl'`, optional peer `xrpl`) — native **USDC + RLUSD**, plus
  native XRP. Memo-bound (Template A): the nonce rides in a Memo (binding) + a derived
  DestinationTag (deliverability). Verification compares **`delivered_amount`**, never
  `Amount`, to defeat `tfPartialPayment`; receiving an IOU needs a one-time trustline.
  Wallets are `{ seed }`; custom IOUs via `{ issuer, currencyHex, decimals }`.
- Every token address verified on-chain before shipping (XRPL issuer Domains →
  circle.com / ripple.com, codes via `gateway_balances`; Tron USD₮ decimals 6 / symbol
  USDT via TronGrid).

## [0.1.0] — 2026-06-01

Initial release of the standalone PipRail SDK. One job: accept x402
"402 Payment Required" payments on any EVM chain **and Solana**, with no
hosted service, no account, no database, and no fee — payments settle
straight into your wallet. The API is small and self-contained.

### Accept payments
- `requirePayment(options)` — Express/Connect middleware that gates a route.
  Issues the `402` challenge, then verifies the payment on-chain and calls
  `next()`.
- `createPaymentGate(options)` — framework-agnostic core (`challenge` +
  `verify`) for Hono, Fastify, Workers, Next.js, Bun, Deno, Adonis, etc.
- Payments are verified **locally against the chain's RPC** — that the tx
  succeeded, has enough confirmations, moved at least the required amount of
  the right token to `payTo`, and was mined recently. No third party.
- In-memory replay protection (a used-tx set + a recency window), overridable
  via `isUsed` / `markUsed` for multi-instance deploys.

### Make payments
- `PipRailClient` — wraps `fetch`; on a `402` it pays on-chain, waits for
  confirmation, and retries with proof. `fetch` / `get` / `post` methods and
  `onEvent` observability. EVM wallets are `{ privateKey }` or a viem
  `{ walletClient }`; Solana wallets are `{ secretKey }` or `{ signer }`.

### Chains
- **15 EVM mainnets + Solana + TON**, selected by name: `'ethereum'`, `'base'`,
  `'arbitrum'`, `'optimism'`, `'polygon'`, `'bnb'`, `'avalanche'`, `'mantle'`,
  `'sonic'`, `'linea'`, `'scroll'`, `'celo'`, `'zksync'`, `'unichain'`,
  `'worldchain'`, `'solana'`, and `'ton'` — each with canonical USDC (and USDT
  where it exists) pre-filled. **Every token address was verified on-chain
  before shipping**, and each chain's default RPC was checked live.
- **TON** (the Telegram blockchain) ships USD₮ (Tether) — verified on-chain.
  Native USDC does **not** exist on TON (Circle doesn't issue it there), so it's
  intentionally absent; pass a custom jetton via `{ master, decimals }` for
  USDe / bridged tokens. TON payments use jettons (TEP-74); the proof carries
  the gate's nonce as the transfer comment, so it's bound to its challenge, and
  verification reads the merchant's own jetton wallet (a look-alike jetton can't
  satisfy it). Wallets are `{ mnemonic }` (24 words) or `{ keyPair }`.
- `token` is **required** — a gate always states exactly what it accepts
  (`'USDC'` / `'USDT'` / `'native'` / a custom `{ address, decimals }` or
  `{ mint, decimals }`). The symbol resolves to the right contract + decimals;
  there is no silent default.
- Solana and TON **auto-mount** on first use — name `chain: 'solana'` or
  `chain: 'ton'` and the driver loads itself with one lazy import, so pure-EVM
  installs never download them. No setup call; just install the peer deps
  (`@solana/web3.js @solana/spl-token bs58`, or `@ton/ton @ton/core @ton/crypto`).
- Any other EVM chain works by passing a viem `Chain` or `{ id, rpcUrl }`
  plus a `{ address, decimals }` token. No allowlist, no testnet presets —
  test against mainnet with small amounts.
- Built on a `PaymentDriver` contract (EVM + Solana ship; register your own
  with `registerDriver`). `CHAINS` and `resolveChain` are exported too.

### Notes
- Self-custody throughout: the payer signs and broadcasts their own transfer
  to your wallet; PipRail never holds funds.
- `viem ^2.21` is a peer dependency. Node 20+ or a modern browser.

[1.0.0]: https://www.npmjs.com/package/@piprail/sdk
[0.1.0]: https://www.npmjs.com/package/@piprail/sdk
