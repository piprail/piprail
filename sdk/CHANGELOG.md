# Changelog

All notable changes to `@piprail/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning](https://semver.org/).

## [2.10.0] — 2026-06-20 — x402 parity: verifiable receipts · the `upto` metered rail · A2A transport

Four ratified-x402 capabilities, all **additive and opt-in** — omit the new options and the 402, the
200, and the pay path are byte-identical to 2.9.0.

- **feat(receipts): verifiable receipts — chain-grounded (no key) + optional EIP-712 attestation.**
  `receipts: true` on a gate emits a self-contained `PipRailReceipt` on every settled payment, in a
  byte-compatible `extensions['offer-receipt'].info` block. **Anyone** re-verifies it against the chain
  with only an RPC: `PipRailClient.verifyReceipt(receipt)` re-reads the settlement tx and re-derives
  `payTo`/`asset`/`payer`, **ignoring the receipt's claims** (never throws; `amount` is a verified lower
  bound; `payer` genuinely re-derived). `client.lastReceipt()` captures it after a paid `fetch`. The new
  additive wire field is `X402Receipt.nonce?` (required to re-verify the five memo-bound families:
  Stellar/XRPL/NEAR/Algorand/TON). **Tier 2 (EVM-only):** `receipts: { attest: { wallet } }` also signs
  the official x402 offer-receipt EIP-712 `RECEIPT_TYPES` with the merchant's existing `payTo` wallet —
  attesting the one thing the chain can't (that the resource was *served*); verify with
  `PipRailClient.verifyAttestation`. `includeTxHash` defaults **true** (PipRail-default verifiability — a
  deliberate, documented divergence from the reference privacy-default; flip to `false` for the §5.3
  empty-string privacy path). New exports: `buildReceiptExtension`, `parseReceiptExtension`,
  `PipRailReceipt`, `SignedReceipt`, `ReceiptInput`, `ReceiptOption`, `ReceiptVerification`.
- **feat(upto): the ratified `upto` (metered / variable-amount) rail — EVM-Permit2, self-settle.** The
  buyer signs a Permit2 authorization for a **maximum**; the merchant serves, meters, then self-settles
  the **actual** (`≤ max`) from its own relayer through the on-chain `x402UptoPermit2Proxy` — backendless,
  no fee. Opt in with `upto: { relayer, settleAmount }` and meter inside `settleAmount` on a direct
  `gate.verify()` call (`requirePayment` throws for `upto` — it settles before the handler serves). A
  zero charge settles nothing on-chain. New `X402UptoAcceptEntry` / `Permit2UptoAuthorization` types +
  `parseUptoPaymentHeader` / `buildUptoSignatureHeader` codecs.
- **feat(transport): A2A — `gate.verifyObject()` + the A2A seller handler.** `gate.verifyObject(payload)`
  verifies a raw-JSON payment object (not just a base64 HTTP header), and `createA2APaymentHandler(gate)`
  maps a gate onto Google's A2A JSON-RPC Task/Message metadata — **sharing one replay set with HTTP**.
  Backendless, zero `@a2a` dependency. The parser cores `parseSignatureObject`/`parseExactObject` are now
  exported. *(The A2A buyer, AP2 carriage, and the live-Google-interop emit-version finalization trail.)*
- **feat(agent/mcp): an 8th tool — `piprail_verify_receipt`** (read-only, key-less) re-verifies a receipt
  against the chain; `piprail_pay_request` now surfaces the `verifiableReceipt`.
- **fix:** a batch of correctness hardening from an adversarial multi-agent audit — require the replay
  store's `isUsed`/`markUsed` as a pair (a lone one silently disabled double-spend protection); the read
  methods (`planPayment`/`canAfford`/`estimateCost`) degrade instead of throwing on a malformed accept;
  Sui coin pagination; Stellar custom-asset decimals; Tron native safe-integer; and more.
- **fix:** a second adversarial multi-agent conformance pass (vs the cloned x402 spec) hardened the new
  surfaces — **upto cumulative caps are now merchant-proof:** the budget debits the authorized **MAX**
  (a merchant that under-reports its settled `amount` can no longer loosen `maxTotal`/`maxTotalPerDenom`/
  `windowTotal`); the metered actual is surfaced on `SpendRecord.settledBase`. The `upto` driver now
  enforces **strict** `permitted.amount === advertised max` at verify time (an over-permit is rejected —
  x402 `scheme_upto_evm` §Phase 3). `describe()` now projects the upto rail's mandatory
  `extra.facilitatorAddress` (+ the exact rail's EIP-712 domain) so a discovered rail is reconstructable.
  A2A conformance: a rejected proof re-challenges as `payment-rejected` (the spec status that pairs with
  the retryable `input-required`, not the terminal `payment-failed`) carrying a failure receipt with
  `network` + `transaction:''`. The agent guide + `paymentTools` JSDoc now document the upto rail and the
  8th tool.
- **fix:** a third verification pass (regression-focused) caught two **doc copy-paste bugs** that would
  brick a user's code — the `upto` seller + Tier-2 receipt examples used the pre-v2 `{ privateKey }`
  wallet field (which throws `WrongFamilyError`) instead of the unified `{ key }`. Also: the A2A
  terminal-`failed` receipt now carries the attempted `network`; the A2A `fulfill` doc/example returns a
  structurally valid artifact (`{ name, parts }`); the MCP config docs + registry `server.json` now list
  `upto`; and a **regression test** locks the merchant-proof cumulative leash (a sequence of
  under-reporting `upto` payments is refused by `maxTotal`/`maxTotalPerDenom`/`windowTotal`).
- **fix:** a fourth, end-to-end pass (every flow traced hop-by-hop + a clean-room standards sign-off,
  which came back **CONFORMANT on all four wire formats**, and a live MCP-pays-the-`upto`-rail proof)
  found only doc-accuracy gaps + one low edge case: A2A failure receipts now attribute `network` from
  the buyer's submitted payload (covering multi-network gates + v1-flat exact payloads), and the whole
  docs-site is updated to the **8-tool** surface (the new `piprail_verify_receipt`) with the 2.10.0
  receipts/upto/A2A APIs documented in the reference. No SDK behavior change beyond the A2A edge fix.

## [2.9.0] — 2026-06-19 — Cross-token grand total · payment-count caps · durable budget · richer spend observability

Spend controls grow up — a single budget across every token and chain, caps on the *number* of
payments, a budget that can survive a restart, and first-class decline/threshold events. Everything
is **additive and opt-in**: omit the new fields and behaviour is byte-identical to 2.8.0.

- **feat(policy): `maxTotalPerDenom` — the cross-token GRAND TOTAL.** Cap "$20 total across every
  stablecoin and chain, full stop" with one number: `policy: { maxTotalPerDenom: { USD: '20.00', EUR: '5.00' } }`.
  The SDK sums the human value of every token of that denomination (USDC/USDT/USD1/FDUSD/RLUSD → `USD`,
  EURC → `EUR`; extend via `denomFor`) and refuses the payment that would breach it
  (`reasonCode: 'BUDGET'`). **Not a price oracle** — PipRail still reads no market and never prices a
  volatile coin; it's a user-declared unit-of-account sum (each token counted 1:1), and native/unknown
  tokens are never in a bucket. Coexists with the per-asset `maxTotal`; the stricter cap wins. Exported
  helpers: `denomOf`, `BUILTIN_DENOMS`, `DENOM_PRECISION`.
- **feat(policy): payment-COUNT caps.** `maxPayments` (lifetime) and `maxPaymentsPerWindow`
  (+ `windowSeconds`) cap the *number* of payments across every chain + token — a rate limit that
  needs no oracle. (`windowSeconds` is now the shared width for the money window AND the count window.)
- **feat(client): durable budget via a pluggable `spendStore`.** Pass `spendStore` and the spend
  ledger hydrates at construction + persists every settle, so `maxTotal` / `maxTotalPerDenom` / the
  count caps **survive a restart** — with no PipRail backend (you own the store, like the gate's
  replay set). Ships `memorySpendStore` (from `@piprail/sdk`) and **`fileSpendStore(path)` from the new
  `@piprail/sdk/node` entry** (a one-line local JSONL log; kept out of the browser bundle). `SpendLedger`
  is now exported so several single-chain clients can SHARE one — `MultiChainPayer.fromWallets` does this
  for you, making the grand total + count caps span every chain as ONE budget (also `spendStore` on its options).
- **feat(client): richer spend observability.** New constructor option `onSpend(record, budget)` —
  the ergonomic "log my spend locally" hook, fired after each settle. Two new additive `PipRailEvent`
  kinds: **`payment-declined`** (the rich decline — typed `reasonCode`, fine `PolicyDenyCode`, the quote,
  and a budget snapshot; `payment-failed` still fires too for back-compat) and **`budget-threshold`**
  (an early warning the first time spend crosses `policy.warnAtFraction` of any cap).
- **feat(client): budget surface extended (additive).** `client.budget()` now also returns
  `byDenom: DenomRemaining[]` (the grand-total leash, previewable *before* any spend) and
  `counts: CountStatus`; new reads `client.denomRemaining()`, `client.countStatus()`, and
  `client.policy()` (the configured leash read back, also on `MultiChainPayer` + the `PayingClient`
  interface). `client.spent()` / `SpendSummary` gains `byDenom: SpendDenomTotal[]`; `SpendRecord` now
  carries `decimals` + `denom`. `formatSpendReport` appends the grand total when present.
- **New deny codes** on `PolicyDenyCode`: `MAX_TOTAL_DENOM`, `MAX_PAYMENTS`, `WINDOW_COUNT` (the
  coarse `DeclineReasonCode` set is unchanged — they map to `BUDGET` / `BUDGET` / `OUTSIDE_WINDOW`).
- **New package entry `@piprail/sdk/node`** (`exports["./node"]`) for the Node-only `fileSpendStore`;
  the core `@piprail/sdk` bundle stays browser-safe (no static `node:fs`).
- **Hardened against an adversarial review** (38-agent fuzz of the new surface). Fixes shipped
  before release — see [Internals & hardening](https://docs.piprail.com/spend-controls/internals/):
  - **OOM/DoS:** an absurd server-stated `decimals` (e.g. `1e9`) is rejected by a new `MAX_DECIMALS`
    (100) bound at the envelope + the `assertValidDecimals` chokepoint (no multi-GB string).
  - **Grand-total bypass (fund safety):** a token labelled `USDC` with `decimals` in `(24, 100]`
    once **escaped** `maxTotalPerDenom`. `DENOM_PRECISION` is now pinned to `MAX_DECIMALS` and the
    denom check **fails closed** (refuses an unscalable capped token, never skips it).
  - **Strictest-cap-wins:** case-variant / whitespace / duplicate denomination keys (`{ USD, usd }`,
    `" USD "`, a repeated CSV denom) now enforce the SMALLEST cap, never silently relax the leash.
  - **Native never bucketed:** a native coin can't be summed into a USD/EUR total even if its symbol
    matches a stablecoin.
  - **Poisoned-store crash-safety:** the ledger validates + skips un-tallyable hydrated records
    (non-numeric/negative `amountBase`, out-of-range `decimals`), so a corrupt store line can't crash
    construction or make `budget()`/`spent()`/`summary()` throw; an unparseable `at` fails closed.
  - **Loud validation:** `expiresAt` (must be a representable epoch-ms), a non-plain-object
    `maxTotalPerDenom`, and a non-string `denomFor` value are all rejected at construction (the last
    would otherwise throw at PAY time, after settlement).
  - **Poisoned `denom` (final-pass fix):** a hydrated store record with a non-string `denom` is
    coerced to "no denomination" (it still tallies per-asset) rather than throwing
    `denom.toUpperCase()` out of construction/reads — completing the crash-safety guarantee.
  - **`budget-threshold` dedup is ledger-scoped:** on a shared cross-chain ledger
    (`MultiChainPayer.fromWallets`) a threshold now fires ONCE for the whole budget, not once per chain.

## [2.8.0] — 2026-06-19 — Solana exact SPL-Memo conformance · TON canonical CAIP-2 (`tvm:-239`) · Toncoin→Gram

- **chore(ton): native coin symbol `TON` → `GRAM` (Toncoin → Gram rebrand).** A TON community
  governance vote renamed the native token *Toncoin → Gram* (ticker `TON` → `GRAM`), live 2026-06-15.
  It's a token-only, presentation-layer rename — the blockchain is still **The Open Network (TON)**, the
  CAIP-2 network id stays `tvm:-239`, and addresses/contracts/jettons are unchanged (no migration). The
  SDK now surfaces the native coin's symbol as `GRAM` (a 402's `extra.symbol`, `describeAsset`, and
  `estimateCost`'s `feeSymbol`); `chain: 'ton'` and `token: 'native'` select it exactly as before, and
  USD₮ / other jettons are unaffected.
- **fix(ton): emit canonical CAIP-2 `tvm:-239` (was `ton:-239`)** — the chainagnostic CAIP-2 registry
  has no `ton` namespace and the merged foundation TON exact scheme mandates the `tvm` namespace, so a
  TON 402's `accepts[].network` (and slug resolution / receipts) now emit `tvm:-239`. This makes
  PipRail's TON 402s matchable by discovery indexes and any standard x402 client/facilitator keying on
  the canonical id. **Back-compat:** the legacy `ton:-239` id is still accepted on parse — an inbound or
  foreign challenge using the old id normalizes to `tvm:-239` and routes/verifies unchanged. The
  internal `ton:<address>|<nonce>` proof-locator prefix is unrelated and unchanged.
- **Solana `exact` SVM conformance — the buyer now emits the spec-required SPL-Memo.** The ratified
  x402 SVM `exact` scheme (§1.2/§3.1) says clients **MUST** include a Memo instruction — `extra.memo`
  verbatim when present, else a random ≥16-byte hex nonce for transaction uniqueness across concurrent
  identical-parameter payments. PipRail's Solana exact buyer previously emitted none, so a seller that
  set `extra.memo` (or a facilitator enforcing the uniqueness Memo) rejected the payment. The buyer now
  appends one SPL-Memo as instruction `[3]`, keeping the exact-rail tx at **4** instructions (still
  inside Path-1's 3-to-7 fast path; SPL-Memo is category-exempt, so it never trips the smart-wallet
  allowlist or the fee-payer drain guard). An `extra.memo` over the 256-byte scheme cap is rejected
  (`UnsupportedSchemeError`). This **changes the exact-rail's default emitted bytes** (a Memo is now
  present) — a *required* conformance change, additive on the wire (old PipRail gates already tolerate
  an inbound Memo). The `onchain-proof` default is byte-identical and untouched.
- **harden(units): validate `decimals` is a non-negative safe integer.** `parseUnits` / `floorUnits` /
  `formatUnits` now reject a negative, fractional, or NaN `decimals` argument up front (instead of
  silently corrupting the bigint math via `padStart` / `slice`) — defence against a malformed preset or
  a bad caller arg. Existing valid calls are unaffected. Thanks to @samsamtrum (#25).

## [2.7.0] — 2026-06-19 — symmetric payment notifications (`onFailed`: both sides notified on success AND failure)

Additive and backward-compatible — defaults and the zero-config 402 stay byte-identical; omit the new
options and behaviour is unchanged.

- **New merchant hook `onFailed(failure)`** on `createPaymentGate` / `requirePayment` — the mirror of
  `onPaid`. It fires whenever a SUBMITTED proof is rejected (a `kind:'invalid'` verdict: wrong amount,
  expired, replayed, unknown asset, …), so the merchant is notified of a failure exactly as the buyer's
  client already is. The new `FailedPayment` it receives carries the SAME machine `code` (a
  `VerifyErrorCode`) the buyer gets — one consistent reason on both sides.
- **`onFailedError(error, failure)`** and **`awaitOnFailed`** mirror `onPaidError` / `awaitOnPaid`: the
  hook is fully isolated (a sync throw or async rejection routes to `onFailedError` — it can never break
  the request or escape as an unhandledRejection), and `awaitOnFailed` runs it before the 402 returns.
- **Exported `FailedPayment` type** — `{ code, detail, transient }`. The `transient` flag is `true` for
  `tx_not_found` / `insufficient_confirmations` (the proof may still be settling and the buyer's client
  auto-retries — alert on `!transient` to avoid false alarms on RPC lag), `false` for a definitive
  rejection (wrong amount, expired, replayed, bad signature, …). Nothing is hidden — every rejected
  attempt still fires `onFailed`.
- **Buyer side:** the `payment-failed` client event now also carries structured `code` / `detail` (the
  server's parsed reason) alongside the existing human `reason`. It now ALSO fires on a **pre-send
  decline** (policy / `onBeforePay` / no settleable rail) — previously those only threw — so a consumer
  watching `onEvent` learns of EVERY failure, not just server rejections (the typed throw is unchanged).
- **Fires only on a real rejection** — not on a normal first-request `challenge` (no proof yet), and not
  on a transient/settlement error that throws (an RPC blip, or a 5xx `SettlementError`): those aren't
  payment verdicts. A failure the merchant never receives a request for (insufficient funds, policy
  decline, abandonment) reaches only the buyer — a backendless gate is passive by design.
- **Examples + tests:** a complete `examples/payment-system/` reference (merchant + buyer — both sides,
  success + failure → a SQLite ledger with a free `/ledger` dashboard); `onFailed` added to the Express +
  Next.js examples. Coverage spans every `VerifyErrorCode`, both rails, the `requirePayment` middleware,
  the `transient` flag, concurrency, replay-after-success, that a thrown `SettlementError`/transient error
  does NOT fire `onFailed`, buyer declines, and a full client↔gate HTTP loop proving both sides receive
  the same `code`.

## [2.6.0] — 2026-06-18 — keyless-gasless `exact` on 7 more EVM mainnets (6 → 13 chains)

Additive and backward-compatible — defaults and the zero-config 402 stay byte-identical; this only
grows the `KNOWN_FACILITATORS` seed map, so `exact: true` now resolves a keyless, gas-sponsoring
facilitator zero-config on **7 more chains**.

- **`exact: true` is now zero-config truly-gasless (buyer AND merchant pay zero native) on Ethereum,
  Polygon, Arbitrum, Optimism, Avalanche, Sei, and Unichain** — joining Base, Monad, BNB, HyperEVM,
  Algorand, and Solana (**6 → 13 chains**). Every new (chain, facilitator) pair was LIVE-settled on
  mainnet with the buyer holding **zero native gas** (provably gasless), per the seed-map RULE
  (settle-proven, never a `/supported` read). **17 new pairs**, e.g. Polygon now lists five keyless
  facilitators (PayAI, Polygon Labs, Corbits, Ultravioleta DAO, Dexter).
- **Base** gains two more keyless facilitators (Cascade, Satoshi/bitcoinsapi).
- **Not seeded (advertised ≠ settles):** Celo and Scroll — Ultravioleta DAO lists them but its sponsor
  contract reverts there (`contract_call_failed`), so neither was ever live-settled. They stay on
  `onchain-proof` until a facilitator actually settles them.
- No API surface change. Merchants on an unseeded network still pass an explicit
  `exact: { settle: { facilitator } }`.

## [2.5.0] — 2026-06-18 — gasless NEAR `exact` rail (NEP-366 meta-transactions)

Additive and backward-compatible — defaults and the zero-config 402 stay byte-identical; pure-EVM
installs still never download a non-EVM library (NEAR + its borsh decoder stay lazy-loaded — verified:
the built EVM bundle has zero static non-EVM imports, only lazy chunks).

### Added

- **NEAR `exact` rail — gasless for the buyer on a fifth family.** PipRail's `exact` scheme now covers
  NEAR (NEP-141 tokens — USDC / USDT) via the ratified
  [`scheme_exact_near`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md)
  (x402 v2). The buyer signs a **NEP-366 `SignedDelegateAction`** authorizing exactly one `ft_transfer`
  with a **full-access key** and never broadcasts it or holds any NEAR; a relayer wraps it, prepays the
  gas + the 1 yoctoNEAR, and submits — the agent is **completely gasless**. Opt-in
  (`schemes: ['onchain-proof', 'exact']`); native NEAR is **not** exact-payable (the scheme is over
  `ft_transfer`) and stays `onchain-proof`. Proven on NEAR mainnet for both USDC and USDT.
  - New `payExactNear` (buyer build/sign) and `verifyAndSettleExactNear` (seller verify + relay) driver
    functions; `resolveExactRail` / `payExact` / `settleExactSelf` are now implemented for NEAR.
  - **Self-settle today** (`exact: { settle: 'self', relayer: { accountId, key } }`): the merchant runs
    a small funded relayer that pays the sub-cent settle gas — the buyer stays gasless, exactly like the
    Solana / Algorand / Aptos self-settle. The **facilitator** path (`settle: { facilitator }`) is wired
    and will work the moment a real NEAR x402 facilitator ships; **none does yet** (some advertise
    `near:mainnet` in `/supported` without settling it), so `exact: true` deliberately excludes NEAR and
    self-settle is the supported gasless-for-buyer config. See the NEAR chain doc for the caveat.
  - **Sponsor fee-drain guard**: the relayer prepays both the gas and the attached deposit, so the gate
    rejects any delegate whose attached `deposit` ≠ exactly 1 yoctoNEAR or whose `gas` exceeds the
    300 TGas cap (re-derived from the trusted rail) **before** the relayer signs.

### Dependencies

- Added **`borsh` (`>=2 <3`) as an OPTIONAL peer dependency** — used only to decode the inbound NEAR
  `SignedDelegateAction` during self-settle, lazy-loaded inside the NEAR driver. NEAR users already have
  it via `near-api-js`; pure-EVM (and non-NEAR) installs never load it.

## [2.4.0] — 2026-06-17 — gasless Algorand & Aptos rails + keyless gasless on SIX chains (incl. Algorand & BNB)

Additive and backward-compatible — defaults and the zero-config 402 stay byte-identical; pure-EVM
installs still never download a non-EVM library (Algorand and Aptos stay lazy-loaded — verified: the
built EVM bundle has zero static non-EVM imports, only lazy chunks).

### Added

- **Algorand `exact` rail — gasless on a fourth family.** PipRail's `exact` scheme now covers Algorand
  (ASAs) alongside EVM and Solana, via the ratified `scheme_exact_algo`. The buyer signs an ASA
  `axfer` to `payTo` at **fee 0**, atomically grouped with a 0-ALGO `pay` whose pooled fee covers the
  group; the sponsor (the merchant's relayer in self-settle, or a keyless facilitator) signs the fee
  txn and submits — the buyer spends **zero ALGO**. New `payExactAlgorand` / `verifyAndSettleExactAlgorand`
  driver functions; `resolveExactRail` / `payExact` / `settleExactSelf` are now implemented for the
  Algorand family. **Live-proven on Algorand mainnet** (self-settle round-trip, buyer paid 0 ALGO).
  Unlike Solana, **`feePayer === payTo` is allowed** (the fee txn is separate — no isolation rule), so
  a single merchant account can self-settle. Native ALGO stays `onchain-proof`-only.
- **Aptos `exact` rail — gasless on a fifth family.** PipRail's `exact` scheme now also covers Aptos
  (Fungible Assets), via the ratified `scheme_exact_aptos`. The buyer builds a fee-payer (sponsored,
  AIP-39) `0x1::primary_fungible_store::transfer` to `payTo` and signs **only the sender slot** — spending
  **zero APT**; the sponsor (the merchant's relayer in self-settle, or a keyless facilitator) adds the
  fee-payer signature and submits, paying the sub-cent gas. It's **one-shot** (no gas-station round-trip,
  unlike Sui's sponsorship — which is why Aptos fits PipRail's backendless model and Sui's gasless path
  doesn't). New `payExactAptos` / `verifyAndSettleExactAptos` driver functions; `resolveExactRail` /
  `payExact` / `settleExactSelf` are now implemented for the Aptos family; the seller verifies by
  **decoding the entry function** and binding the FA metadata/recipient/amount to its trusted rail, caps
  the fee payer's gas exposure, and verifies the sender signature off-chain before settling.
  **Live-proven on Aptos mainnet** (self-settle round-trip, buyer paid 0 APT). Like Algorand,
  **`feePayer === payTo` is allowed**. Any Fungible Asset (USDC + USD₮) is gasless; native APT stays
  `onchain-proof`-only.
- **`exact: true` zero-config gasless now spans SIX chains** — Base, **BNB**, HyperEVM, Monad, Solana,
  and **Algorand** — where a **keyless facilitator sponsors gas for *both* sides** (neither buyer nor
  merchant pays). Each `KNOWN_FACILITATORS` row was added only after a real mainnet keyless settle (THE
  RULE), all 2026-06-17:
  - **Algorand** (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`) — **new keyless chain, the
    first non-EVM/non-Solana one**, via **GoPlausible** (the only keyless Algorand x402 facilitator).
    Atomic-group fee pooling: the sponsor pools the whole group fee, so the **buyer AND the merchant both
    pay 0 ALGO** (tx `PDVDVRFGJAG2K6AJ7L26OTSCSRL7AURVKEX4D4KHBAOLNSCYENXA`).
  - **BNB** (`eip155:56`) — **new keyless chain** via **Dexter** + **Pieverse**, settling the EIP-3009
    tokens **FDUSD/USD1** (BNB's Binance-Peg USDC/USDT are Permit2 → not facilitator-settleable; Dexter
    has a ~$0.003 floor). This beats the BNB token-overlap wall that blocks AEON.
  - **Monad** (`eip155:143`) — **Corbits** + **Ultravioleta DAO** + **Pieverse** (3 facilitators).
  - **HyperEVM** (`eip155:999`) — **Ultravioleta DAO**.
  - **Base** (`eip155:8453`) — PayAI + xpay + **Ultravioleta DAO** + **Dexter** + **Corbits** +
    **GoPlausible** (6 facilitators → automatic failover).
  - **Solana** — PayAI + OpenFacilitator + Corbits (SVM).
  Ultravioleta DAO (the broadest endpoint — 18 PipRail networks) is live-validated on **3** chains
  (HyperEVM, Base, Monad); **GoPlausible** on **2** (Algorand, Base). As more chains are funded the same
  sweep seeds them — **9 more EVM chains have a keyless facilitator awaiting funding** (Polygon, Arbitrum,
  Optimism, Avalanche, Ethereum, Celo, Unichain, Scroll, Sei).
- The `exact` transfer-method union (`ExactRailInfo.method`, `KnownFacilitator.settles`,
  `assetTransferMethod`, the parsed-payment + wire types) now includes **`'algorand'`** and **`'aptos'`**,
  and two new wire payloads are parsed/validated: `ExactAlgorandPaymentPayload` (`{ paymentIndex,
  paymentGroup }`) and `ExactAptosPaymentPayload` (`{ transaction, senderAuth }`).

### Changed

- The gate's facilitator-settle path forwards the sponsor `feePayer` for Algorand and Aptos (as it
  already does for Solana), and the replay claim canonicalizes the Algorand `paymentGroup` and the Aptos
  `{ transaction, senderAuth }` (so a base64-malleated re-submission of the same payment can't slip past
  the used-proof set). All additive — EVM/Solana behaviour is unchanged.
- **Algorand's CAIP-2 is now the FULL 44-char base64 genesis hash**
  (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`, was a 32-char prefix) — the exact form the
  ratified x402 Algorand scheme and its facilitators (GoPlausible) use, so a facilitator-settled rail
  interops on the wire and `fetchFacilitatorFeePayer` auto-matches. The on-chain `exact` group is
  **byte-identical** (GoPlausible accepts PipRail's group as-is — the gate already sends the `amount`
  field it needs); self-settle is **behaviour-neutral** (re-proven live on mainnet). Safe because 2.4.0
  is unreleased, so no published version emitted the prefix form.
- `verifyExact` now matches a v2 `exact` payment's CAIP-2 network **family-agnostically** (any
  `namespace:reference`, not just `eip155:`), so a foreign non-EVM v2 payment (`solana:…`/`algorand:…`/
  `aptos:…`) routes precisely by network on a multi-rail gate instead of relying on the asset filter.
  PipRail's own buyer (which always echoes the asset) is unaffected.

### Security

A pre-release adversarial sweep of every `exact` rail found — and this release fixes — a **sponsor
fee-drain** class on the two rails where the buyer constructs a fee/gas parameter the gate co-signs and
submits from the sponsor's balance (the keyless facilitator, or the merchant's self-settle relayer). In
both cases the buyer signs a valid, correctly-bound transfer, so every other check (recipient, amount,
asset, fee-payer isolation) passed and simulation succeeded — only the fee magnitude was unbounded. Both
now cap it, mirroring the Aptos rail's existing gas caps. Neither shipped in a released version (the
Algorand/Aptos rails are new in 2.4.0; the Solana cap hardens a rail first released in 2.x), and both are
covered by a new red-then-green adversarial test.

- **Algorand** (`drivers/algorand/exact.ts`): the seller co-signed the buyer-supplied pooled-fee `pay`
  txn **without bounding its fee**. A malicious buyer could name the sponsor as fee payer and set an
  arbitrarily large fee, draining it for a sub-cent transfer. Fixed with `MAX_GROUP_FEE` (20 000 µALGO,
  ~10× the honest `minFee × 2`).
- **Solana** (`drivers/solana/exact.ts`): the seller did not bound the **compute-unit limit/price**
  (the priority fee the fee payer pays). A malicious buyer could set a huge `setComputeUnitLimit` ×
  `setComputeUnitPrice` and drain the sponsor's SOL (Solana's max budget makes this multi-SOL per
  request). Fixed with `MAX_COMPUTE_UNIT_LIMIT` (300 000) + `MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS`
  (100 000), enforced before co-signing — worst case ≈ 0.00003 SOL, vs the canonical 20 000-unit @
  1-µlamport path.
- EVM (EIP-3009 / Permit2) and Aptos were reviewed and found **not** exposed: EVM derives gas at
  broadcast (never from the buyer payload), and Aptos already caps gas. The fee-payer drain guards are
  now consistent across all four rails.

## [2.3.0] — 2026-06-17 — `exact: true` zero-config gasless gate

Additive and backward-compatible — defaults and the zero-config 402 stay byte-identical. A new
opt-in shorthand makes the gasless `exact` rail one line, and it degrades gracefully instead of
breaking when no facilitator covers a chain.

### Added

- **`exact: true` on `requirePayment` / `createPaymentGate` — zero-config gasless.** Equivalent to
  `exact: { settle: 'keyless' }`: the gate auto-advertises a gasless `exact` rail and, at settle
  time, picks the first known **keyless** (no-API-key) facilitator for the chain from the built-in
  `KNOWN_FACILITATORS` map, so buyers pay no gas and the merchant runs no relayer. One line, no
  facilitator URL, no relayer key.
- **`ExactRailOption.settle` accepts `'keyless'`** alongside `'self'` and `{ facilitator }`, and
  `exact` accepts `boolean | ExactRailOption`. The boolean shorthand normalizes to
  `{ settle: 'keyless' }`.

### Changed

- **Graceful degrade for the soft path.** When `exact: true` (or `settle: 'keyless'`) is set but no
  keyless facilitator covers the offered chain, the gate **does not throw** — it logs a clear,
  production-visible warning and serves the `onchain-proof` floor (buyers pay their own gas), so a
  resource never goes dark over a coverage gap. An **explicit** `settle: 'self'` or
  `settle: { facilitator }` still throws on a coverage gap (you asked for a specific rail; a silent
  fallback would hide a misconfiguration). Suppress the soft-path hints with `PIPRAIL_NO_HINTS=1`.
- **A failed gasless settlement returns a clear fallback hint.** When a facilitator settle fails at
  pay time, the 502 body now carries a `fallback` field telling the caller the resource also accepts
  `onchain-proof` — retry by paying that rail yourself.



Both changes are additive and backward-compatible — defaults and the zero-config 402 stay
byte-identical; only previously-skipped cases become newly handled.

### Changed

- **The `exact` buyer matches a rail's network whether it's a CAIP-2 id _or_ a chain slug.** The pay
  path now normalizes the offered network (`eip155:8453`, `base`, `bsc`, `56`, …) before matching it to
  the bound chain — the same normalization discovery already used — so a PipRail client interoperates
  with any x402 server or facilitator regardless of how it labels the network. Strictly additive: a
  CAIP-2 label behaves exactly as before; only a chain slug that resolves to the **bound** chain becomes
  newly payable (a different-chain or unrecognized label is never selected, and the trusted EIP-712
  domain still fixes the chain id at signing). Fixes `exact` rails that some facilitators label by slug
  being silently unpayable.

### Added

- **`facilitatorCoverage()` / `parseFacilitatorSupported()` surface two optional per-kind fields** —
  `x402Version` and `assetTransferMethod` (`'eip3009' | 'permit2'`) — when a facilitator's `GET
  /supported` advertises them, so coverage can tell a v1 rail from a v2 rail and an EIP-3009 kind from a
  Permit2 one. Omitted entirely when absent (no `undefined` keys), so a facilitator reporting neither
  parses exactly as before.

## [2.1.1] — 2026-06-15 — discoverability polish (post-2.1.0 audit)

A consistency patch from a deep docs↔source audit of the 2.1.0 discoverability surface. No
behaviour change to any working feature.

### Changed

- **`DiscoverySort` drops the `'latency'` member** (now `'relevance' | 'reliability' | 'price' |
  'uptime' | 'name'`). It was a no-op client-side (no latency field is surfaced on a result) and
  was absent from the `piprail_discover` MCP tool enum — removing it makes the type, the tool, and
  the docs agree. Sort by `'reliability'`/`'uptime'` for endpoint health instead.

### Docs

- Completed the `piprail_discover` / `piprail_register` argument + result tables on the MCP-tools
  and agent-toolkit reference pages with the 2.1.0 params/fields; added `summary` to the
  `DiscoveryDescriptor` table; clarified that `limit` is a per-index-*request* fetch cap (a
  multi-word query fans out into several). Added a committed discoverability sandbox suite.

## [2.1.0] — 2026-06-15 — discoverability: pinpoint search, richer registration, self-describing endpoints

A major upgrade to the discovery surface — making `discover()` find the right resource, `register()`
make yours findable, and every 402 self-explain to an AI agent. All additive and backward-compatible
(defaults unchanged); the zero-config 402 stays byte-identical.

### Added

- **Pinpoint `discover()`.** Multi-word queries now work: the query is **fanned out per word** to 402
  Index (whose `?q=` is AND-tokenized and would otherwise miss them, capped at 5 requests) and the
  merged results are **ranked client-side by relevance** (name > category/tags > URL path >
  description, with a complete-match bonus). A query like `"crypto price feed"` now lands on the
  right resource where it previously returned nothing. Exposed as `rankResources` / `scoreResource`.
- **Server-side filters on `discover()`** — `category` (strict), `asset`, `maxPrice`, `minReliability`,
  `verified`, `paymentValid`, `sort` (`DiscoverySort`: `relevance`/`reliability`/`price`/`uptime`/`name`)
  + `order` — pushed to 402 Index where supported, applied client-side where not.
- **Richer `DiscoveredResource`** — `tags`, `reliabilityScore`, `health`, `verified`, and `score`
  (relevance) so an agent can prefer healthy, verified, on-topic endpoints.
- **Richer `register()`** — `category` (the top findability lever; most of 402 Index is
  `uncategorized`), `tags` (folded into the description as a searchable keyword tail via the new
  `appendKeywords` helper, since index search is literal), `provider`, `contactEmail`, `probeBody`.
- **Self-describing endpoints** — the default-on `extensions.piprail` block gains an optional
  `endpoint` (summary · method · mimeType · input schema · output example) so an AI agent understands
  what an endpoint does, its inputs, and an example output **from the 402 alone, no paid call**. A new
  gate `mimeType` option emits the v2 root `resource.mimeType`; the `discovery` descriptor gains
  `summary` and now lights up BOTH the index-facing `extensions.bazaar` block and the agent-facing
  `extensions.piprail.endpoint`. `gate.describe()` carries `mimeType`. Exposed as `buildEndpointInfo`.

## [2.0.2] — 2026-06-15 — docs/JSDoc accuracy (no code change)

A documentation-accuracy patch from a final repo-wide doc↔source sweep. **No behaviour or API
change** — published purely to refresh the shipped TypeScript JSDoc + npm README.

### Fixed

- **`payExact` SPI JSDoc** (`drivers/types.ts`) said "EVM + EIP-3009 only" — corrected to
  "EVM EIP-3009/Permit2 + Solana SVM", matching the shipped Solana `exact` buyer rail.
- **`WalletInput` JSDoc** notes Tron accepts its hex `key` with or without the `0x` prefix.
- **`ERRORS.md`**: added the `WALLET_REQUIRED` / `WalletRequiredError` row to §2; included Aptos in
  the no-receive-prerequisite list (§6.1); and corrected `UNSUPPORTED_SCHEME` to reflect that
  `exact` now ships on **EVM + Solana** (not EVM-only).

(Docs-site + `llms.txt` accuracy fixes — TON `estimateCost` `cost` fields, the MCP read-only tool
count, the `paymentTools` 7-tool list, the Kaia USDT default, and the additional `@piprail/mcp`
library exports — shipped in the same sweep via the docs/site deploy.)

## [2.0.1] — 2026-06-15 — clearer typed errors (robustness; no API change)

A patch release hardening error reporting at every wrong-input boundary — found by a
repo-wide adversarial fuzzing pass. **No behaviour change for correct input**, no API change;
every fix turns a raw/cryptic library error into a typed `PipRailError` per [`ERRORS.md`](ERRORS.md).

### Fixed

- **Wallet `{ key }` validation is now uniform + typed.** A malformed or wrong-family key throws a
  clear `WrongFamilyError` instead of leaking a library error:
  - **EVM** — a non-`0x…`/short/garbage key (e.g. a base58 secret, or one missing `0x`) →
    `WrongFamilyError` (was viem's raw `invalid private key, expected hex or 32 bytes`).
  - **Solana** — a `0x…` EVM key or non-base58 secret → `WrongFamilyError` (was `Non-base58 character`).
  - **TON** — an invalid/typo'd mnemonic → `WrongFamilyError` at use (was a silent **wrong-wallet**
    derivation that only failed later as an opaque network error); now validated via `mnemonicValidate`.
- **A malformed 402 challenge yields a typed `InvalidEnvelopeError`, never a raw `TypeError`.** An
  `accepts[]` entry missing its `extra` block (on an unrecognised token), or a non-string `amount`,
  is now rejected cleanly across `quote` / `estimateCost` / `planPayment` / `canAfford` / `fetch`
  (a recognised token still prices gracefully from the SDK's own decimals).
- **Read-only agent tools funnel expected errors into a structured result.** `piprail_quote_payment`,
  `piprail_plan_payment`, `piprail_discover`, `piprail_register`, and `piprail_budget` now return
  `{ ok:false, code, reason, explain }` for a typed SDK error (e.g. `WALLET_REQUIRED` on a read-only
  client) — mirroring `piprail_pay_request` — instead of an opaque error; a genuine non-SDK error is
  still re-thrown.
- **A no-gas wallet's settlement failure maps to `InsufficientFundsError`.** viem's gas-estimation
  shortfall phrasing (`gas required exceeds allowance`) is now classified as `INSUFFICIENT_FUNDS`
  (was a raw multi-line viem dump); an ERC-20 `insufficient allowance` (approve) is deliberately NOT
  mis-classified.

## [2.0.0] — 2026-06-15 — one wallet field: `key` (BREAKING)

### Changed — the wallet secret is a single `key` field on every chain (BREAKING)

- **`WalletInput` is unified.** Every chain now takes `wallet: { key }` — the chain's secret as a
  string. NEAR also keeps `accountId`: `{ accountId, key }`. The per-chain secret field names
  (`privateKey` · `secretKey` · `seed` · `secret` · `mnemonic`) are **removed**.
- **Migration** — rename the field; the *value* is unchanged:
  `{ privateKey } → { key }`, `{ secretKey } → { key }`, `{ seed } → { key }`,
  `{ secret } → { key }`, `{ mnemonic } → { key }`, `{ accountId, privateKey } → { accountId, key }`.
  Passing a pre-2.0 field name throws a `WrongFamilyError` whose message names the exact `{ key }` fix.
- **Bring-your-own native signer objects are unchanged** — EVM `{ walletClient }`, Solana `{ signer }`,
  TON `{ keyPair }`, Stellar/Sui `{ keypair }`, XRPL `{ wallet }`, Aptos/Algorand `{ account }`.
- **Why** — one obvious shape across every chain, the whole point of "name a chain, add a wallet."
  See [Wallets by family](https://docs.piprail.com/making-payments/wallets-by-family/).

Nothing else changed: the protocol, drivers, schemes, discovery, spend policy, and every other API
are identical. Live-verified across 11 mainnet chains with the new `{ key }` shape.

## [1.25.0] — 2026-06-15 — more keyless facilitators (live-verified)

### Added — `KNOWN_FACILITATORS` grows beyond PayAI

- **`KNOWN_FACILITATORS`** now seeds three more keyless facilitators, each **live-settled** on mainnet
  through PipRail (a real `exact` payment, buyer paid zero gas), not just read from `/supported`:
  **xpay** on Base (EIP-3009), and **OpenFacilitator** + **Corbits** on Solana (SVM). So
  `firstKeylessFacilitator()` / the `exact: true` shorthand can resolve a keyless sponsor on more
  networks, with redundancy beyond PayAI.
- **Daydreams** and **Questflow** are deliberately **not** seeded: their `/supported` is public but
  `/verify` returns `401` (an API key is required), so they aren't keyless for *settlement*. A public
  `/supported` is not proof of keyless settlement — every seeded entry carries a dated, live-verified note.

### Notes

- Pure data + comments; **no behaviour change** to existing rails or defaults. The full, current provider
  matrix (incl. key-required and self-host options, with on-chain tx proofs) lives in the docs:
  [Facilitator coverage](https://docs.piprail.com/accepting-payments/facilitator-coverage/).

## [1.24.0] — 2026-06-14 — multi-chain buying (one buyer, a wallet per chain)

### Added — pay a 402 on whichever chain it asks for

- **`MultiChainPayer`** — a `PipRailClient` is bound to ONE chain + ONE wallet (an EVM key can't sign a
  Solana tx). `MultiChainPayer.fromWallets({ wallets: { base: { privateKey }, solana: { secretKey }, … }, policy })`
  carries one wallet per chain and exposes a single `fetch`/`get`/`post`/`planPayment`/`canAfford`/`quote`/
  `discover`/`register`/`spent`/`budget`. On a 402 it surveys every funded chain and pays the FIRST chain
  you listed that can actually settle — through each client's own spend policy, `onBeforePay`, retries, and
  replay-protection. No price oracle, no backend, no custody; across coins the order you list the chains is
  the preference (within a chain, the cheapest-gas rail). Also `new MultiChainPayer([...clients])` for full
  control (e.g. custom-EVM viem `Chain`s). `schemes` (incl. the gasless `exact` rail) propagates to every
  chain's client.
- **`fetchAcross(clients, url, init?)`** — the EXECUTION counterpart to `planAcross`: plan across an array
  of single-chain clients and pay, on its owning client, the rail `planAcross` reports as `best` (the first
  funded chain that can settle). Throws `PaymentDeclinedError` with a merged, per-chain funding hint when
  no chain can settle.
- **`PayingClient`** — the shared read-+-pay interface `paymentTools` now accepts; both `PipRailClient` and
  `MultiChainPayer` satisfy it, so the agent toolkit (and the MCP) wrap either unchanged.
- **`piprail_register` agent tool** gains optional `network` + `asset` params, so a multi-chain agent can
  advertise a listing on a specific chain instead of defaulting to the first wallet's chain.

### Changed

- **Cross-chain `best` selection is now your PREFERENCE order, not raw gas magnitude.** `planAcross` /
  `fetchAcross` no longer compare gas fees across different native coins (base units aren't comparable —
  e.g. EVM wei vs Solana lamports — and there's no oracle), which previously let a small-base-unit coin
  win regardless of real cost. They now pay the FIRST chain you list that can settle (within a chain, the
  cheapest-gas rail still wins) — matching the documented contract. Single-chain `PipRailClient` ranking is
  unchanged.
- **`planAcross` now propagates a TOTAL outage.** If EVERY client fails to reach the resource it throws
  (like a single client) instead of returning `null` — so `canAfford`/`quote` can't report a false
  "affordable"/"not-gated". A single chain being down still just drops that chain.
- **Clearer multi-chain decline message.** When no funded chain can settle, `planAcross`'s `fundingHint`
  (and the `PaymentDeclinedError` `fetchAcross` throws) now names EVERY funded chain's own blocker — "top up
  X USDC on base · add ~Y POL gas on polygon" — instead of only the first. Chains the 402 never offered are
  dropped as noise when another chain is close; if none of your chains are offered, it says where the 402
  IS payable. Per-rail `blockers`/`warnings` stay machine-readable for agents that branch programmatically.

Single-chain `PipRailClient` behaviour is byte-identical. Examples: `examples/multi-chain` (routing + a
live gasless-`exact` BNB Permit2 settlement through `MultiChainPayer`).

## [1.23.0] — 2026-06-14 — self-describing endpoints + discovery reach

### Added — self-describing, more discoverable endpoints (discoverability plan: Phases 1, 2, 4, 5)

- **Self-describing 402s, ON by default.** Every challenge a gate builds now carries an
  `extensions.piprail` block — identity, per-rail how-to-pay, `npm i @piprail/sdk` + a paste-ready
  snippet, the MCP command, and docs + discovery pointers — so any human, AI agent, or crawler that
  lands on a gated endpoint (even the `onchain-proof` scheme a stock x402 client can't pay) knows what
  it is and how to pay it. **Purely-additive** metadata in the spec-opaque `extensions` bag, and it
  rides in the response **body** only — the base64 `payment-required` **header stays slim** (just
  `accepts[]` + a small `bazaar`/rejection block), so the header, pay path, `accepts[]`, and status are
  byte-identical (a rejection's `{code,detail}` are deep-merged as siblings and still win). Opt out with
  `requirePayment({ selfDescribe: false })`. New exports: `buildSelfDescription`, `describeChallenge`, `BRAND`.
- **Human landing page + HTTP pointers.** `gate.landingPage(challenge)` / `renderLandingPage()` render a
  tiny, HTML-escaped 402 page for a browser (serve it on `Accept: text/html`; agents/crawlers keep the
  JSON 402). It leads with **how to pay** and a clear **caution** that a manual send to the address won't
  unlock the resource (pay via an x402 client — no custody, no manual-payment desk). `discoveryHeaders()`
  + `POWERED_BY` emit a `Link` (rel `service-desc` / `x402-discovery`) + `x-powered-by` header bag to
  spread on every response. The SDK serves nothing — the merchant does.
- **Facilitator-coverage map.** `KNOWN_FACILITATORS` (+ `knownFacilitatorsFor` /
  `firstKeylessFacilitator`) — shipped data of which keyless facilitators settle `exact` on which
  networks (seeded: PayAI on Base + Solana, dated-verified). `facilitatorCoverage(url)` /
  `parseFacilitatorSupported(body)` read a facilitator's live `GET /supported` (best-effort, never throw).
- **Agent guide** gained a "landing cold — read the self-description" section (surfaced over the MCP).

All of the above is additive + opt-in; the zero-config pay path is byte-identical to before. New pure
modules (`selfdescribe.ts`, `landing.ts`, `facilitators.ts`) join the viem-free protocol-layer grep.

### Removed
- **`base-sepolia` (84532) testnet entry** from `EXACT_NETWORK_SLUGS` and the Permit2 proxy chain-id set
  — mainnets only, no testnet presets (it was dead reference data; nothing settles on a testnet).

### Fixed
- **`x-powered-by` is now ASCII** (`PipRail x402 | https://piprail.com`) — the previous non-ASCII middot
  mangled to `Â·` over Node's latin1 header transport. `GENERATOR` keeps its `·` (JSON body only).
- **`renderLandingPage` never throws** on a rail missing `amount`/`asset` (matches the module's
  never-throw contract).
- **`fetchFacilitatorFeePayer` matches the network normalized** (CAIP-2 *or* slug) so a slug-reporting
  facilitator's Solana exact fee-payer is found instead of silently dropped.

## [1.22.1] — 2026-06-13 — docs: community links + integrations signposting

Docs-only patch — **no code change** (the SDK is byte-identical to 1.22.0). Refreshes the README:
adds a "Spread the word" section (GitHub · X · piprail.com · docs) and surfaces the first-party
integrations (the OpenClaw skill, `clawhub install piprail`) from the repo. Published so the npm
package page carries the updated front door.

## [1.22.0] — 2026-06-13 — optional wallet (read-only client)

A purely **additive, opt-in** feature: `PipRailClient`'s `wallet` is now **optional**. Omit it for a
**read-only client** that can `quote`, `estimateCost`, `discover`, and `register` (402 Index) with no
key — paying, planning, or signing then throws the new typed `WalletRequiredError`. **Supplying a
wallet is byte-identical to every prior version** — the full suite passes unchanged and the wallet is
bound exactly as before; this only adds a key-less path. It's what lets `@piprail/mcp` boot read-only
with no `PIPRAIL_PRIVATE_KEY`.

### Added
- **Optional `wallet`** in `PipRailClientOptions` → a read-only client. `quote` / `estimateCost` /
  `discover` / `register` (402 Index) work with no key; `discoverySigner()` returns `null`.
- **`WalletRequiredError`** (stable code `WALLET_REQUIRED`) — thrown by `fetch` (pay) and `planPayment`
  on a read-only client, so the wallet requirement is explicit and typed.

## [1.21.1] — 2026-06-13 — facilitator hardening + gasless auto-routing + agent-facing docs

A correctness/robustness patch over 1.21.0, after a full re-review and **live mainnet tests of the
facilitator path on both Solana and Base (EVM)**. Opt-in surface unchanged; `onchain-proof` still the
default everywhere.

### Fixed
- **Gasless auto-routing now works on Solana.** The Solana driver's `estimateCost` now reports the
  `exact` rail as **~0 buyer gas** (the fee payer — a facilitator like PayAI, or your relayer —
  broadcasts and pays the SOL fee), mirroring the EVM driver. Before, it reported the same fee as
  `onchain-proof`, so `planPayment()`/`fetch({ autoRoute: true })` wouldn't prefer the gasless rail —
  now they correctly pick it. (Live-proven: autoRoute chooses `exact` even when the buyer holds SOL.)
- **Buyer EIP-3009 domain read is resilient to a flaky RPC.** `payExactEvm` now retries the on-chain
  EIP-712 domain read once before concluding a token "isn't EIP-3009", so a rate-limited public RPC can
  no longer misreport real USDC as un-payable and block an otherwise-valid gasless payment. The error
  message, if it still fails, now names the transient-RPC possibility instead of asserting non-EIP-3009.

### Changed
- **Permit2 can't be facilitator-settled — the gate now says so clearly.** A third-party facilitator
  settles the standard EIP-3009 (EVM) / SVM (Solana) schemes, not PipRail's `x402ExactPermit2Proxy`. A
  *forced* `exact: { method: 'permit2', settle: { facilitator } }` now throws a clear config error, and
  an *auto*-selected Permit2 token is dropped to `onchain-proof`-only over a facilitator (rather than
  advertising a rail it could never settle). Keyed off the resolved method, so Solana (`svm`) is unaffected.
- **Clearer facilitator-unreachable error.** When a Solana facilitator's `GET /supported` can't be read
  at challenge time, the gate now explains the real cause (and points at `exact.settle.feePayer` / 
  `settle: 'self'`) instead of the misleading "none of the offered rails support it".
- **`PIPRAIL_AGENT_GUIDE` now teaches the gasless `exact` rail** — the two rails, that it's operator-opt-in,
  that the on-chain method is auto-selected, and that on a timeout the `exact` `.ref` is an authorization
  **nonce** (re-present the same authorization, never re-sign). Plus docs: the "whole model in 30 seconds"
  (gas vs `onchain-proof` vs `exact`'s three methods), a "when the facilitator fails" breakdown, and
  agent-toolkit/MCP gasless guidance.

## [1.21.0] — 2026-06-13 — standard `exact` rail on Solana (SVM) + fully-gasless facilitator mode

Opt-in, defaults unchanged. `onchain-proof` stays the default on every chain and is byte-identical.

### Added
- **The standard x402 `exact` rail now covers Solana**, not just EVM — so any standard x402
  client/agent that speaks `exact` (the majority) can pay a PipRail Solana gate directly, and a
  PipRail agent can pay any standard Solana `exact` server. Per the ratified `scheme_exact_svm.md`:
  the buyer partial-signs an SPL `TransferChecked` transaction whose **fee payer is the merchant**,
  and the gate co-signs as fee payer + broadcasts against your own RPC — **no facilitator, no
  backend** (the same self-settle model as the EVM `exact` rail). Enable it exactly as on EVM:
  `requirePayment({ chain: 'solana', token: 'USDC', amount, payTo, exact: { settle: 'self', relayer } })`,
  and on the client `new PipRailClient({ chain: 'solana', wallet, schemes: ['onchain-proof', 'exact'] })`.
- **Buyer-gasless on Solana, for any SPL token.** The buyer signs the canonical
  `[setComputeUnitLimit, setComputeUnitPrice, TransferChecked]` transaction and spends **zero SOL** —
  only the token funds the payment. Gasless-ness is transaction-level (the fee payer), not token-level,
  so **USDC and USDT are equally gasless** (no EIP-3009/Permit2 equivalent needed, unlike EVM). The fee
  payer must be **distinct from `payTo`** (a scheme MUST-rule the SDK enforces), and the recipient's
  token account must already exist (the exact rail won't create it — `onchain-proof` does).
- **Solana facilitator mode → _fully_ gasless (neither buyer nor merchant pays).** `exact: { settle: {
  facilitator } }` now works on Solana, not just EVM: the gate auto-discovers the facilitator's
  fee-payer pubkey from its `GET /supported`, advertises it, and forwards settlement — the **facilitator
  pays the gas**. Live-proven on mainnet against **PayAI** (`https://facilitator.payai.network`, no API
  key). Self-settle (your own relayer pays the sub-cent fee) remains available; PipRail hosts nothing
  and is never the fee payer.

### Security (defense-in-depth, after an adversarial review)
- The gate counts **only authentically-signed** transfers toward the required amount (a
  tiny-signed + large-unsigned multi-transfer can't reach the price), enforces fee-payer **isolation by
  resolved pubkey** across every instruction (ALT-safe, not a literal index check), and **canonicalizes**
  the SVM replay key so a base64-malleated re-submission can't bypass the replay claim.

### Changed (internal — no API change)
- The `exact` rail moved behind a new driver SPI, `ResolvedNetwork.resolveExactRail`, so the gate is
  fully chain-agnostic (it no longer special-cases EVM). EVM's EIP-3009/Permit2 method-selection is
  unchanged in behaviour; Solana plugs in `{ method: 'svm', extra: { feePayer, tokenProgram } }`.
- The wire types gained the SVM `exact` payload (`{ transaction }`) and the `extra` keys
  `feePayer`/`memo`/`tokenProgram`; `assetTransferMethod` now also accepts `'svm'`.

## [1.20.1] — 2026-06-11 — gate replay store: bounded + exception-safe

Patch — internal robustness on the gate's built-in replay protection. No API change, no visible
behaviour change, defaults identical.

### Fixed
- **Bounded the default used-proof set.** It's now evicted past the replay window
  (`maxTimeoutSeconds`) instead of growing for the life of the process — safe because the driver's
  recency check rejects any proof that old anyway, so a dropped entry still can't be replayed. A
  long-lived gate no longer slowly leaks memory. Custom `isUsed`/`markUsed` stores are unaffected
  (give them a TTL = the window).
- **`onchain-proof` verification is now claim-release exception-safe.** If a driver's `verify()`
  *throws* (an unexpected RPC exception) rather than returning a rejection, the gate now releases the
  proof reservation before rethrowing — so a transient blip can't permanently burn an otherwise-valid
  proof. This matches the `exact` path, which already did it.

### Docs
- Rewrote **[Replay protection & recovery](https://docs.piprail.com/accepting-payments/replay-protection/)**
  with the full "paid but didn't receive — what happens to the payment?" model (a recoverability
  matrix, the at-most-once-by-design rationale, the bounded-memory behaviour, and the client's
  never-re-pay `.ref` recovery).

## [1.20.0] — 2026-06-11 — discovery hardening: conformance-locked, accurate timing, PipRail-attributed

A minor release focused on the discovery/registration subsystem — verified live against the real
402 Index + the deployed demo's wire, then locked as a contract. No payment-path change; the lazy-chunk
invariant holds.

### Changed — registration attribution is now ON by default (opt-out)
- `client.register()` / `register402Index()` now attribute the listing to PipRail by default: a
  `via: '@piprail/sdk'` provenance field **plus** a tasteful `· Built with @piprail/sdk` suffix on the
  **description** (the one field an index displays) — the same unobtrusive "Made with X" marker as the
  OpenAPI `x-generator`. It's metadata only (never changes how a resource is paid, ranked, or found),
  is **deduped** (never double-stamps a description already naming PipRail), never fabricates a missing
  description, and is **length-guarded**. **Opt out with `attribution: false`.** (Was opt-in/off before
  — this is the one default change in the release; everything else is additive.)
- New pure exports: **`appendAttribution(description)`** and **`REGISTER_ATTRIBUTION`**.

### Fixed — registration timing/visibility now matches reality
- The 402 Index caveat + register `detail` overstated the gate ("not searchable until approved"). Live
  evidence (the demo is self-registered, `domain_verified: 0`, yet fully searchable) shows a self-
  registered listing becomes searchable once it passes 402 Index's automated health + payment-validity
  checks — no domain verification required. Domain verification is the **instant, guaranteed** path
  (+ a verified badge). Wording corrected across `DIRECTORY_INFO`, the docs, and the llms files.

### Added — an x402 conformance contract (test)
- `test/discovery-conformance.test.ts` encodes, as executable predicates, the x402 v2 PaymentRequirements
  envelope (CAIP-2 networks, atomic-unit string amounts, the EIP-712 domain on an `exact` rail) **and**
  x402scan's `validateResource` gate (HTTPS · v2 · non-empty accepts · resolvable input schema · ≥1
  Base/Solana rail), asserted against the live demo's captured wire and the SDK's own generated output —
  so a regression that would make a PipRail endpoint un-listable fails CI.

## [1.19.0] — 2026-06-11 — gasless `exact` on 3 more chains (Monad · zkSync Era · Injective)

A minor, fully additive release — defaults byte-identical (`exact` stays opt-in), no new dependency,
the lazy-chunk invariant holds. The same slug-only path as 1.18.0, extended after on-chain verification.

### Added — gasless EIP-3009 `exact` on 3 more EVM chains → **17 gasless mainnet EVM chains**
- **Monad (143), zkSync Era (324), Injective (1776)** added to `EXACT_NETWORK_SLUGS`. Each ships a
  **native Circle USDC** verified on-chain to the same bar as 1.18.0: `symbol`/`decimals` match,
  `authorizationState` present (the EIP-3009 marker), explicit EIP-712 domain `version` 2, and — the
  check that actually matters for signing — the preset **chainId matches the chain's real
  `eth_chainId`** (a mismatch would have the token reject every signature). All three resolve
  `exact/eip3009` through a live gate end-to-end. The buyer pays **gasless, no approval, no proxy**.
- zkSync Era's native account abstraction is **not a blocker** here: an EOA payer's standard `ecrecover`
  path through the token's FiatToken `transferWithAuthorization` is unaffected, and the EIP-712 domain
  was confirmed correct (chainId 324, version 2).

### Docs
- The **Gasless payments** coverage table now lists all 17 gasless-via-EIP-3009 chains.

### Tests
- `chainIdForExactNetwork` now asserts the 3 new slugs alongside the 1.18.0 set.

## [1.18.0] — 2026-06-11 — gasless `exact` on 7 more chains + a Permit2-proxy guard

A minor, fully additive release — defaults byte-identical (`exact` stays opt-in), no new dependency,
the lazy-chunk invariant holds.

### Added — gasless EIP-3009 `exact` on 7 more EVM chains
- **Sonic, Linea, Celo, Unichain, World Chain, Sei, HyperEVM** added to `EXACT_NETWORK_SLUGS`. Each
  ships a **native Circle USDC** whose `transferWithAuthorization` (EIP-3009) was **verified on-chain**
  (`authorizationState` present), so the buyer pays **gasless, with no approval and no proxy**. This
  roughly **doubles** PipRail's gasless-EVM footprint (7 → 14 mainnet chains). Live-proven on **HyperEVM
  mainnet** (a standard `exact` client signed EIP-3009, the gate self-settled — tx `0xe31f92ee…`).
- (The rail was never gated per-chain in the driver — it's capability-detected at runtime via
  `exactDomain`. `EXACT_NETWORK_SLUGS` is the public `chainIdForExactNetwork` helper + the advertised
  list; it had simply drifted behind the real capability. It's now accurate.)

### Hardened — never advertise an unsettleable Permit2 rail
- The `exact` rail's **Permit2** fallback (for non-EIP-3009 tokens) now checks the **x402ExactPermit2Proxy
  is deployed** on the chain before advertising it. On a chain with neither an EIP-3009 token nor the
  proxy (e.g. Mantle/Scroll/Kaia for their tokens), the gate offers `onchain-proof` only instead of a
  Permit2 rail it could never settle; a forced `method: 'permit2'` there is a clear config error.
- New driver-contract method `exactPermit2Supported?()` (EVM driver implements it from the verified
  proxy-chain set). New public exports: **`PERMIT2_PROXY_CHAIN_IDS`**, **`isPermit2ProxyChain`**.

### Docs
- The chain-specific "Permit2 & BNB Chain" page was consolidated into a comprehensive **Gasless
  payments** page (what gasless means · `onchain-proof` vs `exact` · EIP-3009 vs Permit2 · a clear
  per-chain/-token coverage table). Old URL redirects.

### Tests
- +5 (the 7 new slugs, `isPermit2ProxyChain`, and the proxy-guard: auto-drop, mixed-gate, forced-throw).

## [1.17.0] — 2026-06-11 — `onPaid` hardening: enriched, isolated, durable receipts

A minor, fully additive release — defaults byte-identical (fire-and-forget stays the default,
the wire `X402Receipt` is unchanged), the protocol layer stays viem-free, and the EVM bundle
pulls in **no new dependency** (`deliverReceipt` is global `fetch` + Web Crypto).

### Fixed — an `async onPaid` could crash the process
- The gate's `onPaid` isolation only caught **synchronous** throws; an `async` handler that
  rejected (the common case — a DB/queue/webhook write) escaped as an `unhandledRejection` that
  could crash the process. `fireOnPaid` now isolates a **rejected promise as well as a sync
  throw**, routing both to the new `onPaidError` seam. The "a hook can never break the request"
  guarantee is now true for async handlers too.

### Added — the enriched `PaidReceipt` (what `onPaid` now receives)
- `onPaid` (and the new `onPaidError`) receive a `PaidReceipt`: every `X402Receipt` field **plus**
  `decimals`, `symbol`, `amountFormatted` (formatted from the *settled* amount), and a stable
  `idempotencyKey` (= the settled tx id) — so a receipt handler never needs a second lookup. The
  wire receipt (`result.receipt`, the response header) stays the lean settlement record.

### Added — receipt-hook options on `requirePayment` / `createPaymentGate`
- `onPaid?: (receipt: PaidReceipt) => void | Promise<void>` — now explicitly **sync or async**.
- `onPaidError?: (err, receipt) => void` — observe a failing hook instead of swallowing it
  silently (its own throws are isolated too).
- `awaitOnPaid?: boolean` (default `false`) — await the hook before serving the resource, so
  "receipt recorded" is guaranteed on the happy path. A rejection is still isolated; it never
  turns a settled payment into a 402.

### Added — `deliverReceipt()`, a reliable self-hosted webhook primitive
- `deliverReceipt(receipt, { url, secret, retries, timeoutMs, backoff, headers, onAttempt })`
  POSTs a `PaidReceipt` to **your own** endpoint with retries + exponential backoff, an
  **HMAC-SHA256** signature (`piprail-signature: sha256=…`), and an `idempotency-key` header. It
  **never throws** (failure → `{ delivered: false, … }`), retries `408`/`429`/`5xx`/transport
  errors, and stops on a permanent `4xx`. Isomorphic (global `fetch` + Web Crypto), zero new deps.
  PipRail hosts nothing — the URL is yours. New exports: `deliverReceipt`, `DeliverReceiptOptions`,
  `DeliverAttempt`, `DeliverResult`, and the `PaidReceipt` type.

### Delivery contract (documented)
- `onPaid` is **at-least-once**: exactly once per proof on a single in-memory replay store, but
  across instances sharing a custom `isUsed`/`markUsed` store a race can deliver twice — **dedupe
  on `idempotencyKey`**. Covered on the Receipts & onPaid docs page with queue + webhook patterns.

### Tests
- +22: `test/server-onpaid.test.ts` (enrichment, sync+async isolation, no-`unhandledRejection`,
  `awaitOnPaid` ordering, fire-once-per-settlement) and `test/receipts.test.ts` (retries, backoff,
  permanent-vs-retryable status, HMAC signature verification, idempotency + header precedence,
  timeout/abort, never-throws).

## [1.16.0] — 2026-06-11 — x402 `exact` Permit2 method: BNB Chain is a first-class exact rail

A minor, fully additive feature — defaults byte-identical (`exact` stays opt-in), the protocol
layer stays viem-free, and the EVM bundle pulls in **no new dependency** (Permit2 is EIP-712
signing + one `approve` on the existing `viem` peer; the lazy-chunk invariant still holds).

### Added — the `permit2` asset-transfer method of the x402 `exact` scheme (EVM)
- The `exact` scheme now settles tokens **without** EIP-3009 — most importantly **Binance-Peg
  USDC/USDT on BNB Chain** (no native Circle USDC exists on BNB). Per the x402 spec
  (`specs/schemes/exact/scheme_exact_evm.md`): the buyer signs a Permit2 `PermitWitnessTransferFrom`
  whose `spender` is the canonical **x402ExactPermit2Proxy** (`0x402085…20001`) and whose
  `witness.to` binds the recipient; the merchant/relayer self-settles via the proxy's `settle`.
- **Buyer** — `PipRailClient({ schemes: ['exact'] })` auto-detects `extra.assetTransferMethod` and
  signs EIP-3009 or Permit2 accordingly. The one-time `approve(Permit2)` is done lazily on first use
  (the only on-chain action the buyer takes; gas-free thereafter); `estimateCost` notes it.
- **Seller** — `requirePayment({ exact: { settle: 'self', relayer } })` **auto-selects** the method:
  EIP-3009 when the token supports it, else Permit2 (any ERC-20). New `exact.method?: 'eip3009' |
  'permit2' | 'auto'` (default `'auto'`) pins it. The advertised rail carries
  `extra.assetTransferMethod`; Permit2 replay uses the Permit2 nonce bitmap.
- New public exports: `PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES`, and the
  wire types `Permit2Authorization` / `Permit2PaymentPayload` / `ExactPaymentPayloadAny`.
  `ParsedExactPayment` is now a discriminated union on `method` (`'eip3009' | 'permit2'`). BNB slugs
  added to `EXACT_NETWORK_SLUGS`.
- **FDUSD + USD1 are now default BNB tokens.** Both **are EIP-3009** (unlike Binance-Peg USDC/USDT),
  so the `exact` rail uses the **gasless `transferWithAuthorization` path — no Permit2 approve**.
  They hardcode their EIP-712 domain version (`"1"`) without a `version()` function, so
  `readExactDomain` now **derives the version from the on-chain `DOMAIN_SEPARATOR`** (generalizes to
  any `version()`-less EIP-3009 token). 18-decimal; verified on-chain.

### Verified
- **Live-proven on BNB mainnet** (real USDC, both rails — 402 → pay → 200, balance moved, replay
  rejected): onchain-proof tx `0x4bf044b554e5d1390b5c0fb225bad7501c4fa1e3538005aed144ad153d30eb14`;
  exact/Permit2 self-settle tx `0x6e3ecc3f3230d6e1627db5c233a102dd1878e46bab676302a84f78f30be61589`.
- **FDUSD + USD1 live-proven on BNB mainnet** via the gasless EIP-3009 `exact` rail (domain version
  derived on-chain, replay rejected): FDUSD tx `0xfaec2e82a294790322a24db65458abbe4913a493e81dd66accfcf7a8be5dbfda`;
  USD1 tx `0x10e68722375943a183edd749b67acf05a75baa98680a31b06af804d56a160c28`.

## [1.15.1] — 2026-06-10 — docs consolidation: the README is now a signpost to docs.piprail.com

Docs-only. No code, no API, no behaviour change — `dist` is byte-identical.

### Changed
- **`README.md` trimmed to a signpost.** The full manual now lives at **[docs.piprail.com](https://docs.piprail.com)**, the single source of truth. The README keeps a one-line pitch, install, two tiny examples, and a docs link table.
- **Slimmer npm tarball.** `CHAINS.md`, `ERRORS.md`, `STANDARDS.md`, and `DISCOVERY.md` are no longer shipped in the package (`files`) — they duplicated the docs site (or are internal contributor contracts). The package now ships `dist` + `README.md` + `CHANGELOG.md` + `LICENSE`.
- In-repo, `CHAINS.md` and `DISCOVERY.md` are reduced to pointers at the canonical docs; `ERRORS.md` is reframed as the internal driver error contract (the user-facing error model lives at [docs.piprail.com/errors](https://docs.piprail.com/errors/error-model/)).

## [1.15.0] — 2026-06-10 — the trusted agent wallet (budget-bound, time-boxed, asks-first)

A minor, fully additive layer — defaults byte-identical, no new error code, protocol
layer stays viem-free.

### Added — a TIME dimension on `PaymentPolicy` (Mode A)
- Four opt-in fields make the spend leash a *clock* too: `ttlSeconds` / `expiresAt` (a
  session deadline — past it EVERY pay is refused with `reasonCode:'SESSION_EXPIRED'`,
  TERMINAL) and `windowTotal` + `windowSeconds` (an optional rolling rate-limit, per
  `(network, asset)`). All default off → behaviour unchanged. A half-armed window
  (`windowTotal` without `windowSeconds`) or an unsafe `ttlSeconds` throws at construction.
- `client.budget(): SessionBudget` and `PaymentPlan.session` surface the remaining money +
  time leash so a headless agent can SEE it before paying. `client.remaining(): SpendRemaining[]`
  gives the per-asset cap, ledger-scoped. All read-only, never throw, process-scoped (reset on restart).
- `PolicyDecision` gains a typed `code` (`PolicyDenyCode`); `PayBlocker` gains `OUTSIDE_WINDOW`.

### Added — agent ergonomics (the model-facing contract)
- `PaymentDeclinedError.reasonCode` (`'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' | 'SESSION_EXPIRED'
  | 'APPROVAL'`) — a typed discriminator so an agent branches on the cause (and spots a TERMINAL
  decline) without parsing prose. No new `.code`.
- The `piprail_pay_request` tool now funnels EVERY `PipRailError` into a structured
  `{ ok:false, code, reason, explain, ref?, reasonCode?, declined? }` — never an uncaught crash, so a
  broadcast-but-unconfirmed timeout reaches the agent with its `.ref` and the never-re-pay rule.
- New pure exports: `summarizePlan` / `explainDecline` / `formatSpendReport` (NL renderers, wired into
  the tool outputs), `classifyChallenge` + `ChallengeTriage` (scheme/chain triage), and
  `PIPRAIL_AGENT_GUIDE` / `agentGuide` (the cross-tool contract).
- `paymentTools()` now returns **7** tools — the original 5, plus read-only `piprail_budget` and
  `piprail_guide` appended last (the first five are byte-identical in name + order).

## [1.14.0] — 2026-06-10

### Added — pay the standard `exact` rail (opt-in, EVM + EIP-3009)
- **`PipRailClient` can now PAY standard x402 `exact` rails**, not just PipRail's native
  `onchain-proof` — so an agent can transact with ANY standard v2 x402 server (the dominant
  `exact`-on-Base-via-CDP web), while PipRail's own gates stay backendless. **Opt-in** via a new
  `schemes` option (default `['onchain-proof']` — the zero-config path is byte-identical):
  `new PipRailClient({ chain: 'base', wallet, schemes: ['onchain-proof', 'exact'] })`, with a per-call
  override `fetch(url, { schemes: ['exact'] })`. EVM + EIP-3009 only (USDC/EURC); silently ignored on
  non-EVM chains, for USDT/native, or for a token the SDK can't price (those keep `onchain-proof`).
- The buyer signs an EIP-3009 authorization with **its own** wallet and the server / merchant-chosen
  facilitator broadcasts it — the buyer pays ~0 gas and PipRail hosts/settles nothing. `quote()`,
  `planPayment()`, `estimateCost()`, `canAfford()`, `autoRoute`, and `planAcross()` are now truthful
  across both schemes (an exact rail is priced gasless: `cost.fee === '0'`, never an `INSUFFICIENT_GAS`
  blocker). The EIP-712 domain is **re-derived on-chain** (`name()`/`version()`), never trusted from
  the server's `extra`. The same `policy` + `onBeforePay` gate it BEFORE any signature.
  **Verify against your target facilitator before production.**
- **EURC is now a built-in EVM preset token** on Ethereum, Base, and Avalanche (on-chain-verified;
  EIP-3009, 6 decimals) — so the `exact` buyer recognises it and the "USDC/EURC" coverage is real, not
  aspirational. (Its EIP-712 domain name differs per deployment — `"Euro Coin"` on Ethereum/Avalanche,
  `"EURC"` on Base — which the buyer re-derives on-chain; the symbol is display-only.)
- `X402ExactAcceptEntry.extra.name`/`version` are now OPTIONAL (the exact-EVM scheme only requires
  `assetTransferMethod`) — matching the spec; the buyer ignores them (it re-derives on-chain), the gate
  still populates them from its own on-chain read. The `payment-settled` event now also carries the
  conformant `settle?: SettleOutcome` (a third-party facilitator's lean SettleResponse, when there's no
  rich receipt).
- New exports: `buildExactSignatureHeader`, `parseSettleResponse` (+ the `SettleOutcome` type), the
  `PaymentScheme` type, and the `UnsupportedSchemeError` (`code: 'UNSUPPORTED_SCHEME'`). New driver SPI
  method `payExact?` (optional, EVM-only). `@piprail/mcp` adds the `PIPRAIL_SCHEMES` env (unset ⇒ the
  SDK default, so the MCP's zero-config posture is unchanged).

### Changed (additive — minor, but type-affecting)
- `PayOption.accept` and the `payment-required` event's `accept` are now `X402AnyAccept` (was
  `X402AcceptEntry`). A consumer that reads `accept.extra.nonce`/`minConfirmations` without a `scheme`
  guard should narrow on `accept.scheme === 'onchain-proof'` first.
- The buyer emits **v2 only** for `exact` (`PAYMENT-SIGNATURE` + the `accepted`-envelope). v1-only
  servers (which never parse as a v2 challenge here) are out of scope for this milestone.

## [1.13.1] — 2026-06-10

### Fixed
- **`register()` visibility is now accurate for a verified domain.** 402 Index returns a structured
  `service.status` — a register from a domain you've verified comes back `'active'`, so the outcome now
  reports `visibility:'live'` instead of the conservative `'pending-review'` default (`decorateOutcome`
  honours a visibility the adapter already set). The `detail` already surfaced 402 Index's own message;
  now `visibility` and `detail` agree.

## [1.13.0] — 2026-06-10

### Added — gate `discovery` option (one flag → x402scan-listable)
- **`createPaymentGate`/`requirePayment` now take an opt-in `discovery` option** that emits an
  `extensions.bazaar` block **in the 402 challenge itself** — so the gate alone satisfies x402scan's
  mandatory input-schema check (no separately-served file needed). `discovery: true` for a no-input
  GET, or a `DiscoveryDescriptor` (`{ method, queryParams, output }`). Omitting it leaves the challenge
  byte-identical. New export `buildBazaarExtension` + the `DiscoveryDescriptor`/`BazaarExtension` types.
- `DomainClaim` now also surfaces `verificationToken`, and `verificationHash` is **always** populated —
  from the API, or computed as `sha256(verificationToken)` — so an agent always has the exact bytes to serve.

### Fixed — conformance bug hunt (20-agent audit, every finding verified against the live API)
- **`hostOf` returned `''` for a bare `host:port`** (`new URL('x.com:8080')` parses the host as a scheme) —
  `claimDomain`/`verifyDomain` now extract the host correctly.
- **`indexes.ts` base64 was Latin1-only** (`btoa`) — now UTF-8-safe, matching `x402.ts` (a non-ASCII SIWX
  field could have thrown in the browser).
- **SIWX message** now reads `chainId` from `supportedChains[]` as a fallback (not only `info.chainId`),
  so it always signs the correct `Chain ID`.
- Removed an invented `x-payment-info.bazaar:{discoverable:true}` marker from `buildOpenApi` (no index read it).
- Documented the caveat that the open indexes' agents are standard `exact` clients — advertise an `exact`
  rail to be *payable*, not just listed (README + the `piprail_register` MCP tool).

## [1.12.0] — 2026-06-09

### Added — One-call domain verification (pending-review → searchable)
- **`client.verifyDomain()` takes a 402 Index listing all the way to searchable.** A self-registered
  402 Index listing is `pending-review`; verifying the domain you control approves it (and every other
  pending listing on it). `client.claimDomain(urlOrDomain, { contactEmail? })` returns the
  `verificationHash` to serve at your `/.well-known/402index-verify.txt`; `client.verifyDomain(urlOrDomain)`
  then flips it live. Standalone forms `claim402IndexDomain` / `verify402IndexDomain` + the
  `DomainClaim` / `DomainVerification` types are exported. Never throws; moves no funds.

### Docs — a complete, agent-followable discovery playbook
- Rewrote the **"Be discoverable"** README section into a top-to-bottom **4-step playbook** an agent can
  follow (list → verify domain → discover → self-describe), with the corrected lifecycle output
  (`visibility` + `note`), a `DIRECTORY_INFO` reference table, and the caveats inline (402 Index is
  pending-review; `discover()` doesn't read x402scan; x402scan needs an input schema). Updated
  `llms-full.txt` to the same four moves (EMIT · REGISTER · VERIFY · DISCOVER).

## [1.11.0] — 2026-06-09

### Added — Agent-friendly discovery lifecycle
- **`register()` outcomes now tell an agent when/where a listing is findable.** Each
  `RegisterOutcome` carries a `visibility: 'live' | 'pending-review' | 'not-listable'` plus a
  plain-language `note` — projected from a new exported source-of-truth, **`DIRECTORY_INFO`**
  (per-index: review mode, auth, chains, `readByDiscover`, caveat). So an agent reads the caveat
  right where it already is instead of guessing. New exports: `DIRECTORY_INFO`, `getDirectoryInfo`,
  `decorateOutcome`, and the `DirectoryInfo` / `ListingVisibility` types.
- **The sharp caveats are now explicit** (in the types, the `note`, and `register()`/`discover()`
  JSDoc): **402 Index lists a self-registered resource as `pending-review`** (not searchable until
  approved — verify your domain on 402index.io for instant approval), **`discover()` does NOT read
  x402scan** (a live x402scan listing won't appear there — don't read its absence as failure), and
  **CDP Bazaar can't list a backendless PipRail resource at all** (facilitator-coupled).

### Docs — x402 v1/v2 version posture made authoritative
- A definitive comment in `x402.ts` documents the stance: **emit strict v2, accept liberal v1 + v2**
  (Postel). v2 *replaced* v1 on the wire; the current reference client `@x402/fetch` is v2, but the
  original `x402-fetch`/`x402-express`/`x402-next` packages still send v1, so the gate keeps accepting
  it. PipRail emits no v1 *body* on its own paths; the lone v1 emitter is the `encodeXPaymentHeader`
  utility (its `x402Version: 1` default is correct — consistent with the v1-flat shape it builds).

### Fixed
- Corrected stale "searchable within seconds" wording for 402 Index (it added a review queue):
  `register402Index`'s success `detail` now surfaces the index's own message, and the JSDoc + MCP
  `piprail_register` tool description reflect the `pending-review` reality.

## [1.10.0] — 2026-06-09

### Added — Universal Payments (the standard x402 `exact` rail)
- **Get paid by ANY standard x402 client.** A gate can now opt into advertising a ratified x402
  `exact` rail (EIP-3009) **alongside** its backendless `onchain-proof` rail (dual-advertise) —
  `requirePayment({ …, exact: { settle: 'self', relayer: { privateKey } } })`. A standard client
  (`x402-fetch`, `@x402/fetch`, …) picks `exact`; a PipRail client picks `onchain-proof`. Opt-in;
  omitting `exact` leaves the gate byte-identical. EVM + EIP-3009 only (USDC/EURC); USDT, native, and
  non-EVM chains stay `onchain-proof` (a clear config error if you request `exact` on them).
- **Two backendless settlement modes.** `settle: 'self'` broadcasts `transferWithAuthorization` from
  the merchant's own relayer key (payer spends **zero** gas; the merchant pays gas to receive — the
  signature binds `to`, so no redirect risk). `settle: { facilitator }` delegates verify+settle to a
  third-party x402 facilitator the merchant chooses (Coinbase CDP, x402.org, …) via the new pure
  `settleViaFacilitator` — PipRail hosts nothing either way.
- **EIP-712 domain read from the token.** The exact rail reads `name()`/`version()` from the contract
  (never assumed from the symbol — USDC's domain name is `"USD Coin"`, EURC's is `"EURC"`, bridged
  USDC differs), so it's correct across all 18 built-in EVM USDC chains. Proven live: a real
  `@x402/fetch` reference client settles against a PipRail gate on Base mainnet.
- New exports: `ExactRailOption`, `SettlementError` (`SETTLEMENT_FAILED`), `signature_invalid`
  (`VerifyErrorCode`), `settleViaFacilitator` + `FacilitatorConfig`, `parseExactPaymentHeader`,
  `readExactDomain`, `eip3009Abi`, the `X402ExactAcceptEntry`/`X402AnyAccept`/`ExactPaymentPayload`
  types, and the v1 header constants `HEADER_SIGNATURE_V1`/`HEADER_RESPONSE_V1`.

### Changed — x402 v2 conformance
- **A rejected proof is now a conformant 402.** The gate re-issues a full v2 `PaymentRequired`
  re-challenge on rejection (carries `accepts[]` so a standard client can retry, the human reason in
  `error`, and the machine code in `extensions.piprail`) instead of the old non-standard
  `{ status: 'invalid' }` body. The built-in `requirePayment` adapter emits it automatically; the
  client reads the structured reason. `toInvalidBody` is **deprecated** (kept for back-compat) — prefer
  the gate's `result.challenge`.
- **Receive + respond on both header sets.** The gate accepts an inbound payment on `PAYMENT-SIGNATURE`
  (v2) **or** `X-PAYMENT` (v1), and emits the settlement on both `PAYMENT-RESPONSE` and
  `X-PAYMENT-RESPONSE`, so deprecated-but-common v1 clients interoperate on the `exact` rail.
- A fresh challenge now omits `error` (was `error: null`) and may carry `extensions`/`resource.mimeType`.

### Fixed
- **UTF-8-safe base64 envelope codec.** The wire codec preferred `btoa`/`atob`, which are Latin1-only —
  and modern Node defines them globally — so a challenge/receipt containing a non-ASCII byte (a chain
  error `detail`, an `…` in a viem message, a token symbol) threw `InvalidCharacterError`. It now
  prefers `Buffer` and bridges through `TextEncoder`/`TextDecoder` in the browser.

## [1.9.0] — 2026-06-08

### Added
- **Kaia** (ex-Klaytn, chainId 8217) — EVM preset for South Korea's stablecoin-settlement chain
  (born from Kakao + LINE). Pay **native KAIA** or **Tether-native USD₮**
  (`0xd077A400968890Eacc75cdc901F0356c943e4fDb`, verified on-chain: symbol `USD₮`, name
  "Tether USD", 6 dp, no bridge markers). Circle issues no native USDC on Kaia, so USDC is
  intentionally omitted (pass it as a custom token if you need a bridged one). Brings the built-in
  set to **29 chains across 10 families** (20 EVM mainnets).

### Changed
- **CHAINS.md — verified stablecoin provenance.** Now documents, per chain, whether the shipped
  USDC/USDT is issuer-native, **USDT0** (LayerZero), a **canonical-bridge** token, or **Binance-Peg** —
  every address re-verified on-chain. Documentation only; no code or behaviour change, all tokens
  unchanged.

## [1.8.0] — 2026-06-06

### Added
- **Agent tool annotations.** Each of the five `paymentTools(client)` descriptors now carries an
  advisory `annotations` object (MCP-style `ToolAnnotations`: `title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`), so an MCP client or agent can reason about a
  tool's nature and render the right consent. The three reads (`piprail_discover` / `quote` / `plan`)
  are flagged **read-only**; `piprail_pay_request` is flagged **value-moving** (not read-only,
  destructive, non-idempotent) so a client can surface that it's the one tool that spends;
  `piprail_register` writes a listing but is non-destructive. New exported type `ToolAnnotations`.
  Backward-compatible — `annotations` is optional and non-MCP runtimes ignore it. (`@piprail/mcp`
  ≥ 0.2.2 passes them through on the wire.)

## [1.7.0] — 2026-06-06

### Added
- **Discovery — find and be found, $0 and backendless.** Closes the one open gap: a 402 endpoint was
  payable but invisible. PipRail now builds on the **open** x402 indexes that already exist (402 Index,
  the CDP Bazaar read API, x402scan) — **nothing PipRail-hosted, no registry, no database** (the
  no-backend/no-marketplace rule is intact). Three opt-in moves, defaults byte-identical:
  - **Emit** — pure, no-I/O artifact builders `buildOpenApi` / `buildWellKnownX402` / `buildX402DnsTxt`
    (in a new chain-agnostic `discovery.ts`), fed by a new **`gate.describe()`** accessor that maps a
    gate's resolved options to nonce-free `PaymentRail`s. Serve the result as a static file on your own
    origin (the OpenAPI-first `/openapi.json` convention the live indexes parse).
  - **Register** — **`client.register(url, opts?)`** lists a resource on the open registries: **402 Index**
    by default (no auth, no signature, no payment) and optionally **x402scan** via SIWX (one wallet
    signature; Base/Solana only). Returns a `RegisterOutcome[]`; a step the chain can't satisfy comes
    back `{ ok:false, detail }`, never a throw. Standalone `register402Index` / `registerX402Scan` too.
  - **Discover** — **`client.discover(opts?)`** reads the open indexes (CDP Bazaar + 402 Index, free),
    merges + dedupes them, and by default returns only resources payable on the client's chain. Standalone
    `searchOpenIndexes`. Never throws for a read problem (a dead index contributes nothing).
  - **Agent tools** — `paymentTools(client)` gains **`piprail_discover`** and **`piprail_register`** (now
    five tools); they flow through `@piprail/mcp` automatically (the MCP is a pass-through — zero `mcp/` changes).
  - **One new OPTIONAL driver method** — `ResolvedNetwork.discoverySigner?(wallet)` → `{ address, signMessage }`,
    for ownership proofs / SIWX **only** (never the payment path). Implemented for EVM (eip191, recoverable
    with `recoverMessageAddress`); families that omit it simply skip signature-gated registration — the
    402 Index path needs none. The first optional contract method.
  - New exports: the three emitters + `searchOpenIndexes` / `register402Index` / `registerX402Scan` /
    `normalizeNetwork`, and the types `PaymentRail` · `ResourceDescription` · `ManifestInput` ·
    `OpenApiDocument` · `OpenApiOperation` · `WellKnownX402` · `X402DnsRecord` · `DiscoverySource` ·
    `DiscoveredResource` · `DiscoveredRail` · `RegisterOutcome` · `RegisterInput` ·
    `SearchOpenIndexesOptions` · `DiscoverOptions` · `RegisterOptions` · `DiscoverySigner`.
  - Additive + non-breaking (next release is a minor). Honest caveats documented: the open indexes assume
    the `exact` scheme (offer an `exact` Base/Solana rail to be *usefully* listed; `discover()` results are
    cross-scheme, `fetch()` pays only `onchain-proof` rails directly), x402scan is Base/Solana-only, and
    there is no single ratified discovery standard yet (OpenAPI-first is an emerging multi-vendor convention).
  - **Every chain, guaranteed.** Discovery works on *any* chain — a built-in preset, a non-EVM family, or a
    custom `{ id, rpcUrl }` chain: 402 Index registers without a signature or chain allowlist, and `discover()`
    never silently hides a rail whose network it can't resolve (delegating to the bound driver's `supports()`).
    The slug→CAIP-2 map now mirrors every family's exact `caip2`. The only chain-limited piece is the optional
    x402scan target (Base/Solana, its own limit). Documented in DISCOVERY.md §2.5 and proven by
    `test/discovery-e2e.test.ts`, which parametrizes every family + a custom chain end-to-end.
  - **Docs:** a new **`DISCOVERY.md`** ships with the package — the complete discovery reference (problem,
    open infra, the three moves with every function/option, the signing primitive, the agent tools, the
    end-to-end flows, the every-chain guarantee, and the caveats). README + AGENTS link it; the site gains a
    dedicated **piprail.com/discovery** page (and the tablet/mobile nav is now a slide-in overlay).
  - **Tests:** comprehensive coverage across every variation — emitters (paths/query/unicode/limits), the
    open-index adapters (envelopes, never-throws, price parsing), `discover`/`register`/`discoverySigner`, the
    agent tools, a real merchant→agent end-to-end loop, every-chain proofs, and stress (hundreds of
    resources/rails, concurrency, malformed input).
  - **Experimental + live-verified.** Discovery integrates with third-party open indexes (moving, unratified
    conventions) so it ships flagged **experimental**. Validated live (2026-06-06) against the real services:
    the read path normalizes real CDP Bazaar + 402 Index data and the x402 protocol filter drops L402/MPP;
    `client.discover()` merges both; and `register402Index` POSTs correctly — **402 Index probes the URL and
    only lists endpoints that truly return a `402`** (a non-402 URL gets HTTP 422, handled without throwing).
    `RegisterOutcome.detail` now **surfaces the index's own rejection reason** (e.g. "Your endpoint returned
    HTTP 200 instead of 402") instead of a bare status. x402scan SIWX register is not yet live-tested. Full
    log in DISCOVERY.md §10.
  - **Tasteful "built with PipRail" attribution** (three honest channels, no spam): `buildOpenApi` stamps
    `x-generator: "@piprail/sdk · https://piprail.com"` at the doc root **by default** (opt out with `attribution: false`); every
    open-index request sends `User-Agent: @piprail/sdk (+https://piprail.com)` (a request header — can't
    affect validation; live-verified sent); and `register(url, { attribution: true })` adds a best-effort
    `via: '@piprail/sdk'` listing tag, **off by default** (live-verified that 402 Index tolerates the field —
    a tagged register behaves identically to an untagged one). New export: `GENERATOR`.

## [1.6.0] — 2026-06-05

### Added
- **`policy.tokens` accepts `'native'`** — a chain-agnostic alias that allows the chain's native coin
  (ETH/BNB/TRX/XLM/…) by the same word the accept side already uses (`token: 'native'`), without naming
  the per-chain ticker. It's matched on the asset (not the symbol), so it works on every family; symbol
  matching is unchanged (the real ticker still works), and `'native'` only ever matches a genuinely
  native asset — it never loosens a stablecoin allowlist. Closes a terminology gap where allowing native
  payments previously required knowing the coin's symbol. `@piprail/mcp`'s `PIPRAIL_TOKENS` inherits this.
  Additive + non-breaking (next release is a minor).

## [1.5.1] — 2026-06-04

**Cosmetic polish — docs & comments only, zero behavior change.** A repo-wide tidy pass so the
in-code docs match the SDK as it actually ships (10 families / 28 chains). No runtime, API, type,
or wire change — every existing program behaves identically.

- **JSDoc parity across the public surface.** The `chain` / `token` / `payTo` / wallet docs on
  `RequirePaymentOptions`, `AcceptOption`, and `PipRailClientOptions` now enumerate all 10 families
  (Aptos + Algorand were missing); the typed error JSDoc (`WrongFamilyError`, `UnknownTokenError`,
  `MissingDriverError`, `RecipientNotReadyError`) lists every family + install command + custom-token form.
- **Stale comments corrected.** Native TRX and native NEAR are documented as the payment assets they've
  been since 1.1.0 (the old "not a payment asset" / "`'native'` is rejected" notes were removed); the
  `'native'` coin list, the barrel header, the tsup code-split note, and the lazy-mount docs now name all
  9 non-EVM families; the `paymentTools` doc says "three tools" (quote · plan · pay).
- **Driver-family symmetry.** `evm/wallet.ts` gained the `── EVM SECTION: wallet ──` banner the other 9
  families carry, and `evm/index.ts`'s `recipientReady()` comment now uses the shared "No receive
  prerequisite —" lead-in.
- **Docs:** README contract-method list adds `balanceOf` / `recipientReady`; README custom-token examples
  add Aptos + Algorand; CHAINS.md lists HyperEVM + Monad (and their USDT gap); ERRORS.md + AGENTS.md list
  all 10 families; CHANGELOG version footer links restored.
- **Packaging:** `algosdk` moved to its alphabetical slot in `peerDependencies` (no dependency change).

## [1.5.0] — 2026-06-04

**The killer agent feature — `client.planPayment(url)`.** A read-only call that surveys a 402
across every rail it offers *on your chain* against your wallet's OWN holdings — **token balance +
native gas + recipient-readiness** (trustline / ATA / storage_deposit / ASA opt-in / activation) —
and tells you, crystal-clear, whether it's settleable, on which rail, and if not, exactly what to
top up. It completes the trio the SDK already ships: **`quote()` (what it costs) → `estimateCost()`
(the gas) → `planPayment()` (can I actually settle, and where).** Fully backward-compatible and
opt-in; defaults are unchanged. The official x402 client picks `accepts[0]` blind; PipRail is the
only backendless SDK that can answer "can I actually pay this?" across 28 chains with pure RPC
reads, no oracle/facilitator/bridge. Live-proven on Algorand mainnet (ready / recipient-not-ready /
insufficient / multi-rail-rank, 4/4).

### Added
- **`client.planPayment(url, init?)` → `PaymentPlan | null`.** Never throws for a read problem (a
  transient/RPC failure surfaces as a rail in `state: 'unknown'` + a warning, never a false
  "unaffordable"); returns `null` when the URL isn't 402-gated; and when the 402 offers no rail on
  your chain it EXPLAINS that (status `blocked` + a hint) instead of throwing. The plan carries:
  `payable` + `best` (the cheapest settleable rail), `options[]` (every rail with typed `blockers`
  — `INSUFFICIENT_TOKEN`/`INSUFFICIENT_GAS`/`RECIPIENT_NOT_READY`/`OUTSIDE_POLICY` — plus soft
  `warnings`, a `shortfall`, live `balance`, and `recipient.fix`), and a one-sentence `fundingHint`.
- **`client.canAfford(url)` → `boolean`** — convenience over the above.
- **`fetch(url, { autoRoute: true })` / `new PipRailClient({ autoRoute: true })`** — opt-in:
  `fetch` pays the cheapest rail the wallet can ACTUALLY settle (not the first policy-passing one),
  or throws `PaymentDeclinedError` carrying the funding hint before any send. **Default off** —
  the zero-config path is byte-identical.
- **`planAcross(clients, url)`** — the cross-chain brain: give it one client per chain you fund and
  it merges their plans, payable-first (no oracle, so the cross-coin tiebreak is your client order).
- **`piprail_plan_payment`** agent tool (budget-bound; `paymentTools(client)` now returns 3 tools).
- **Driver contract:** `balanceOf(wallet, asset)` + `recipientReady(payTo, asset)` on every family
  (10/10), RPC-read-only and NEVER-throw (transient ⇒ `null`/`'unknown'`, per ERRORS.md §5). Real
  receive-prerequisite probes on NEAR (`storage_balance_of`), Stellar/XRPL (trustline presence),
  Algorand (ASA opt-in); truthful `'n/a'` on EVM/Solana/TON/Tron/Sui/Aptos (no prerequisite).
- New exported types: `PaymentPlan`, `PayOption`, `PayBlocker`, `PayWarning`, `RecipientReason`,
  `WalletBalance` (and the previously-missing `AptosToken`/`AlgorandToken`).

## [1.4.0] — 2026-06-04

A new chain **family** — **Algorand** — the **10th driver family**, bringing the built-in count to
**28 chains across 10 families (19 EVM)**. Algorand is genuinely part of the **official x402
standard** (its `exact` scheme is merged into the canonical x402 repo and the `@x402/avm` package),
and one of the loudest agentic-commerce chains of 2026 — but the incumbent x402 path there is
**facilitator-mediated**, so PipRail is the **first facilitator-free, backendless, verify-locally
x402 SDK on Algorand**. Fully backward-compatible; `algosdk` is a lazy-loaded optional peer, so
pure-EVM (and other) installs never download it.

### Added
- **Algorand (`chain: 'algorand'`, CAIP-2 `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`)** — native
  Circle **USDC** (ASA `31566704`, 6 dp) + native **ALGO** (6 dp). The USDC ASA was verified live on
  mainnet (algod `/v2/assets/31566704` → unit-name `USDC`, decimals 6, creator = Circle's `2UEQ…`
  account, url `centre.io/usdc`) before shipping. **USDC-only:** Tether deprecated USDT on Algorand
  (frozen 2025-09-01), so it's intentionally omitted — pass it as a custom `{ assetId, decimals }`.
- **Template A (memo-bound, like Stellar/XRPL/NEAR):** every Algorand transaction carries an
  arbitrary **note field (≤1KB)**, so the challenge nonce rides in it verbatim (no hashing needed —
  a UUID dwarfs nothing of the 1KB cap). `verify()` re-derives the watched account from the
  **trusted `accept.payTo`** (never the client ref), reads its recent inbound transfers via the
  indexer, and matches `note === nonce` + recipient + asset + amount + recency — a proof is
  cryptographically bound to its challenge. Native ALGO is a `pay` txn; USDC/ASAs are `axfer`; both
  carry the note. Amounts are integer base units (like EVM). `algosdk` is an **optional peer
  (`>=3 <4`)**, lazy-loaded on first use; the built EVM bundle stays free of any static `algosdk`
  import (its own chunk).
- **Receive prerequisite:** to receive a USDC/ASA, the recipient must **opt into the ASA** (a
  one-time 0-amount self-transfer) — conceptually identical to an XRPL/Stellar trustline. A submit
  failure for a not-opted-in recipient maps to the typed `RecipientNotReadyError`; native ALGO needs
  no opt-in.

**Live-proven on Algorand mainnet — both assets, 12/12.** Real 402 → pay → confirm → verify → 200
round-trips, each with balance moved + replay rejected (`tx_already_used`) + all agent surfaces
green: **native ALGO** 6/6 (tx `AXXJVYAP7BLK6C76AWCJ3XA5HTECIRSCNRQ2WLFRNSZ6CD5GH32Q`) and
**USDC** 6/6 (tx `INWCUUBAMIBYOPPUOBWXEHZQAQL6KSV7DPEEVGKAI64Z46TRQKOA`, merchant +0.05 USDC).
Also verified against the test contract (typecheck + 441 tests + build + the lazy-chunk invariant).
Funding follow-up: file an Algorand **xGov retroactive** grant for the shipped open-source SDK
(SDKs/libraries are a named eligible category).

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

[2.8.0]: https://www.npmjs.com/package/@piprail/sdk
[2.7.0]: https://www.npmjs.com/package/@piprail/sdk
[2.6.0]: https://www.npmjs.com/package/@piprail/sdk
[2.5.0]: https://www.npmjs.com/package/@piprail/sdk
[2.4.0]: https://www.npmjs.com/package/@piprail/sdk
[2.3.0]: https://www.npmjs.com/package/@piprail/sdk
[2.2.0]: https://www.npmjs.com/package/@piprail/sdk
[2.1.1]: https://www.npmjs.com/package/@piprail/sdk
[2.1.0]: https://www.npmjs.com/package/@piprail/sdk
[2.0.2]: https://www.npmjs.com/package/@piprail/sdk
[2.0.1]: https://www.npmjs.com/package/@piprail/sdk
[2.0.0]: https://www.npmjs.com/package/@piprail/sdk
[1.25.0]: https://www.npmjs.com/package/@piprail/sdk
[1.24.0]: https://www.npmjs.com/package/@piprail/sdk
[1.15.1]: https://www.npmjs.com/package/@piprail/sdk
[1.15.0]: https://www.npmjs.com/package/@piprail/sdk
[1.14.0]: https://www.npmjs.com/package/@piprail/sdk
[1.13.1]: https://www.npmjs.com/package/@piprail/sdk
[1.13.0]: https://www.npmjs.com/package/@piprail/sdk
[1.12.0]: https://www.npmjs.com/package/@piprail/sdk
[1.11.0]: https://www.npmjs.com/package/@piprail/sdk
[1.10.0]: https://www.npmjs.com/package/@piprail/sdk
[1.9.0]: https://www.npmjs.com/package/@piprail/sdk
[1.8.0]: https://www.npmjs.com/package/@piprail/sdk
[1.7.0]: https://www.npmjs.com/package/@piprail/sdk
[1.6.0]: https://www.npmjs.com/package/@piprail/sdk
[1.5.1]: https://www.npmjs.com/package/@piprail/sdk
[1.5.0]: https://www.npmjs.com/package/@piprail/sdk
[1.4.0]: https://www.npmjs.com/package/@piprail/sdk
[1.3.1]: https://www.npmjs.com/package/@piprail/sdk
[1.3.0]: https://www.npmjs.com/package/@piprail/sdk
[1.2.0]: https://www.npmjs.com/package/@piprail/sdk
[1.1.1]: https://www.npmjs.com/package/@piprail/sdk
[1.1.0]: https://www.npmjs.com/package/@piprail/sdk
[1.0.0]: https://www.npmjs.com/package/@piprail/sdk
[0.1.0]: https://www.npmjs.com/package/@piprail/sdk
