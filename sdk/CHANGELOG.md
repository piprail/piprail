# Changelog

All notable changes to `@piprail/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning](https://semver.org/).

## [1.3.1] — 2026-06-04

Aptos pay-path fix surfaced by the live mainnet test — no API change, fully compatible with 1.3.0.

### Fixed
- **Aptos: cap `maxGasAmount` (50k) on the Fungible-Asset transfer.** Aptos validates
  `max_gas_amount × gas_unit_price` against the sender's balance *before* execution, so the SDK
  default (200k units) made a tiny transfer demand ~0.5 APT held just to be admitted — a wallet
  with a modest APT balance was rejected with `INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE` even
  though the transfer itself uses a fraction of that. A `primary_fungible_store::transfer` (even
  one that creates the recipient's primary store) stays well under 50k gas units, so the cap keeps
  ample gas headroom while the upfront fee requirement stays small. Live-validated on Aptos mainnet.

## [1.3.0] — 2026-06-04

A new chain **family** — **Aptos** — the **9th driver family** and the only Move L1 with BOTH
canonical native stablecoins. Brings the built-in count to **27 chains across 9 families (19 EVM)**.
Aptos has an official `exact` scheme merged into the canonical `coinbase/x402` repo and is a
first-class x402 / agent-payments network. Fully backward-compatible; `@aptos-labs/ts-sdk` is a
lazy-loaded optional peer, so pure-EVM (and other) installs never download it.

### Added
- **Aptos (`chain: 'aptos'`, CAIP-2 `aptos:1`)** — native Circle **USDC**
  (`0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b`) + native Tether **USD₮**
  (`0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b`), both 6 dp, plus native
  **APT** (8 dp). Both Fungible-Asset metadata addresses were verified on-chain
  (`0x1::fungible_asset::Metadata` → matching symbol + decimals) before shipping.
- **Template B (digest-bound, like Sui/Tron):** the proof ref is the tx hash; `verify()` re-derives
  payTo's primary store for the required FA metadata from the **trusted accept** (never the client
  ref) and matches `0x1::fungible_asset::Deposit` events to it (+ recency window + single-use proof
  set). Every asset — native APT and both stablecoins — transfers via
  `0x1::primary_fungible_store::transfer` (native = the APT FA at `0xa`), which auto-creates the
  recipient's primary store, so there's **no opt-in / coin-store registration to receive** — even a
  fresh recipient works. `@aptos-labs/ts-sdk` is an **optional peer (`>=2 <8`)**, lazy-loaded on
  first use; the built EVM bundle stays free of any static `@aptos-labs/ts-sdk` import (its own chunk).

Live mainnet smoke (a real APT + USDC/USDT round-trip) is the separate ship-gate, pending wallet
funding; the driver is verified against the test contract (typecheck + 416 tests + build).

## [1.2.0] — 2026-06-04

Two new EVM presets — **HyperEVM (Hyperliquid)** and **Monad** — bringing the built-in count to
**26 chains across 8 families (19 EVM)**. Both reuse the existing EVM driver: one row of
on-chain-verified data each, no new code path and no new peer dep. Fully backward-compatible.

### Added
- **HyperEVM (Hyperliquid), `chain: 'hyperevm'`, chainId 999** — native Circle USDC
  (`0xb88339CB7199b77E23DB6E890353E22632Ba630f`, 6 dp; CCTP V2). The highest-activity EVM venue
  of 2025–26 (perps DEX + on-chain agent vaults). Pay in USDC or native HYPE. HyperEVM's USDT is
  USDT0 (LayerZero), not Tether-native, so it's omitted (pass it as a custom `{ address, decimals }`).
- **Monad, `chain: 'monad'`, chainId 143** — native Circle USDC
  (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, 6 dp; CCTP V2). The biggest new EVM L1 of 2025
  (parallel EVM, ~10k TPS). Pay in USDC or native MON. USDT0 omitted, as above.

Both addresses were verified on-chain (live `eth_chainId` + `symbol()`/`decimals()`) before
shipping; `chain: 'hyperevm'` / `chain: 'monad'` work with no setup call.

## [1.1.1] — 2026-06-03

Docs + examples only — **no code change**; the API and every chain behave exactly as 1.1.0.

### Docs
- **"In the browser — no build, no npm" guide** in the README. `@piprail/sdk` is browser-clean
  and runs from any npm-mirroring CDN (`esm.sh` / `jsDelivr`), so a plain HTML page can take or
  make payments with no bundler — the CDN resolves `viem` and any lazily-imported chain lib.
  Verified end-to-end (gate + client, Node + browser, plus a real on-chain payment made **from a
  browser**). Includes the injected-wallet pattern and a loud "never ship a raw key in client-side
  HTML" warning.

### Examples
- **New `examples/browser/`** — a single self-contained HTML file that loads the SDK from a CDN and
  runs a live in-browser x402 demo (build a real `402` challenge, quote it), no build step. A hosted,
  interactive version of the same demo is live at https://piprail.com/demo.

## [1.1.0] — 2026-06-03

Found by the live-test campaign: **native NEAR + native TRX are now payment assets** (native
coin now works on all eight families), a native-TON verify fix, **double-pay-safe handling of a
flaky RPC after broadcast**, **per-chain `rpcUrl` in multi-chain accepts**, and a new per-chain
setup reference. Fully backward-compatible — the public API and every existing chain/token behave
exactly as before; the only behaviour change is that a post-broadcast confirmation timeout now
recovers (submits the proof) instead of throwing the proof away.

### Added
- **Native NEAR (`token: 'native'`) is now supported.** Previously NEAR was NEP-141-only
  (`token: 'native'` threw). Native NEAR now works via **digest-binding** — exactly like
  EVM/Solana/Sui: a plain `Transfer`, verified by tx hash + a recency window + the gate's
  single-use set (the NEP-141 path stays memo-bound, unchanged). The big win: native NEAR
  needs **no `storage_deposit`** and a transfer even **creates a fresh implicit recipient** —
  the zero-setup NEAR path. (NEAR is the volatile gas coin, so for stable pricing pay in
  USDC/USDT; native is ideal for no-setup flows.) `decimals: 24`. Live-mainnet validated;
  pay + verify unit tests added.
- **Native TRX (`token: 'native'`) is now supported.** Previously Tron was TRC-20-only
  (`token: 'native'` threw). Native TRX now works via **digest-binding** — a plain
  `TransferContract`, verified by txid + a recency window + the gate's single-use set
  (the verifier reads the tx's TransferContract instead of a Transfer event log, and gates
  finality on the solidity node). USD₮ stays the default (TRX is volatile gas); native is
  there for completeness. A first native payment to a brand-new recipient also pays Tron's
  ~1 TRX account-creation fee (sender side). `decimals: 6`. Live-mainnet validated; pay +
  verify unit tests added. **With this, native coin is a valid payment asset on every one
  of the eight families — no exceptions.** (Tron still has no native USDC — Circle
  discontinued it — so USD₮ remains its only built-in stablecoin.)
- **New typed error `RecipientNotReadyError` (`code: 'RECIPIENT_NOT_READY'`)** — surfaced when a
  payment can't be delivered because the **recipient** isn't set up to receive on that chain (a
  chain *state* requirement, not the payer's balance), so it's never mistaken for an SDK bug or
  for affordability. `send()` now maps the recipient-side chain signals to it with a plain-language
  fix that **echoes the raw chain code** and preserves the original error on `.cause`:
  XRPL `tecNO_DST*` (account not activated — needs ≥1 XRP base reserve) / `tecNO_LINE*` ·
  `tecPATH_DRY` · `tecDST_TAG_NEEDED` (no trustline / tag); Stellar `op_no_destination` (account
  doesn't exist) / `op_no_trust` (no trustline); NEAR `… is not registered` (needs `storage_deposit`).
  Sender affordability still converges on `InsufficientFundsError` everywhere — the two are now
  cleanly separable by `.code` (fund the payer vs. set up the recipient). Pay-path unit tests added
  for Stellar/XRPL/NEAR; exported from the package root.
- **Per-chain `rpcUrl` in multi-chain `accept[]`.** Each accept option already resolved with its
  own `rpcUrl` (falling back to the top-level) — now **documented and unit-tested**, so a
  multi-chain merchant can pin a reliable endpoint per chain and one throttled public RPC can't
  take down verification for the others. The `rpcUrl` stays server-side (never leaked into the challenge).

### Hardened
- **A broadcast payment is never silently lost to a flaky RPC (double-pay prevention).** If the
  transfer broadcasts but the client's own `confirm()` times out — the classic free-RPC failure
  where the tx *lands* but the status poll 429s past the validity window — the client no longer
  throws the proof away (which would orphan a real payment and invite a re-pay). It now emits a new
  **`payment-unconfirmed`** event, submits the proof to the server (the on-chain authority) with
  **more patient retries** (a floor of 6), and **never re-broadcasts**. If the server still can't
  confirm, `MaxRetriesExceededError` / `PaymentTimeoutError` now carry **`.ref`** (the broadcast proof)
  so a caller re-verifies instead of re-paying. The server side was already safe — a failed
  verification read returns `tx_not_found` → 402 (locked), never a false `paid`, and releases the
  replay claim so the same proof can be re-submitted once the RPC recovers. Found by the live-test
  campaign (a Solana tx that finalized while the public RPC 429'd the read-back). Unit tests added
  (`test/client-confirm-timeout.test.ts`); documented in README + `ERRORS.md` §4.1.

### Fixed
- **Native TON (Toncoin) payments to a brand-new recipient now verify.** A native TON
  transfer to an *uninitialized* `payTo` (a fresh wallet that has never deployed its
  contract) credits the recipient, but TON marks that recipient's receiving transaction
  `aborted` — there's no contract code to run the comment message. `verifyTon`'s
  `txSucceeded()` compute-phase check read that as a revert and returned `tx_reverted`,
  rejecting a payment the merchant had **actually received**. The check is now applied to
  **jetton** credits only (a jetton credit must execute the recipient's jetton-wallet
  contract); a **native** receipt is valid by message delivery itself — a non-bounced
  internal message always credits its value, regardless of the recipient's compute phase.
  USD₮ (jetton) verification is unchanged. Regression test added in `test/ton/verify.test.ts`.

### Docs
- Added **[`CHAINS.md`](CHAINS.md)** — a per-chain setup & caveats reference: native-vs-token
  support per chain, NEAR `storage_deposit`, TON's API-keyed RPC requirement, Stellar/XRPL
  trustlines + reserves, Tron gas, the wallet shape per family, and how each proof binds.
  Linked from the README, with the headline caveats also called out there and on piprail.com.
- **"Why did my payment fail?" docs** — README and `CHAINS.md` now spell out, per chain, what the
  *recipient* must have to receive (activation / trustline / account / `storage_deposit`) and which
  error (`INSUFFICIENT_FUNDS` vs `RECIPIENT_NOT_READY`) maps to which raw chain code + fix; `ERRORS.md`
  documents the new code (§2) and the sender-vs-recipient split (§6.1).

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

[1.1.0]: https://www.npmjs.com/package/@piprail/sdk
[1.0.0]: https://www.npmjs.com/package/@piprail/sdk
[0.1.0]: https://www.npmjs.com/package/@piprail/sdk
