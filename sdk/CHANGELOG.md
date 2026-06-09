# Changelog

All notable changes to `@piprail/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning](https://semver.org/).

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
