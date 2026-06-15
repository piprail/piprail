---
title: SDK API reference
description: The full public surface of @piprail/sdk — every export grouped by job, with the headline APIs marked and a link to where each one is documented.
sidebar:
  order: 1
---

## Introduction

This is the map of everything `@piprail/sdk` exports — grouped by the job it does, with the
**headline** APIs marked and the **advanced** tiers (wire codecs, low-level `exact`, the driver
SPI) kept clearly separate. Each group links to the page that documents it in full.

Two entry points cover the 99% case: **`requirePayment` / `createPaymentGate`** to *get paid*,
and **`PipRailClient`** to *pay*. Everything else is built on those.

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'
```

## Accept payments (server side)

The server-side surface. `requirePayment` is Express/Connect middleware; `createPaymentGate` is
the same logic, framework-free.

| Export | Kind | Marked |
| --- | --- | --- |
| `requirePayment` | fn | **Headline** |
| `createPaymentGate` | fn | **Headline** |
| `deliverReceipt` | fn | Reliable receipt webhook — signed + retried POST to **your** endpoint |
| `toInvalidBody` | fn | Deprecated |
| `RequirePaymentOptions`, `AcceptOption`, `ExactRailOption` | type | carries `onPaid` / `onPaidError` / `awaitOnPaid` |
| `ChainSelector`, `TokenInput` | type | — |
| `PaymentGate`, `VerifyPaymentResult` | type | — |
| `PaidReceipt` | type | The enriched receipt `onPaid` receives |
| `DeliverReceiptOptions`, `DeliverAttempt`, `DeliverResult` | type | — |
| `X402InvalidBody` | type | — |
| `ExpressLike{Request,Response,Next,Middleware}` | type | — |

See [requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/),
[Defining accepts](/accepting-payments/defining-accepts/),
[Verifying payments](/accepting-payments/verifying-payments/), and
[Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) (the `PaidReceipt`, `onPaidError`,
`awaitOnPaid`, and `deliverReceipt`).

## Pay (agent side)

The client. One `PipRailClient` binds a chain + wallet and exposes the read-only trio
(`quote` → `estimateCost` → `planPayment`) plus `fetch`. `MultiChainPayer` carries one wallet
per chain and auto-routes a 402 to whichever chain can settle it.

| Export | Kind | Marked |
| --- | --- | --- |
| `PipRailClient` | class | **Headline** |
| `MultiChainPayer` | class | **Headline** — one buyer, a wallet per chain |
| `planAcross`, `fetchAcross` | fn | plan / pay across an array of single-chain clients |
| `PipRailClientOptions`, `MultiChainPayerOptions`, `WalletInput`, `PaymentScheme` | type | — |
| `PayingClient` | type | the read-+-pay surface both `PipRailClient` and `MultiChainPayer` satisfy |
| `PipRailQuote`, `PipRailCostQuote`, `PipRailEvent` | type | — |
| `PaymentPlan`, `PayOption`, `PayBlocker`, `PayWarning` | type | — |
| `SessionBudget`, `SpendRemaining` | type | — |

See [Quote](/making-payments/quote/), [Estimate cost](/making-payments/estimate-cost/),
[planPayment()](/making-payments/plan-payment/),
[fetch & autoRoute](/making-payments/fetch-and-autoroute/),
[Multi-chain buying](/making-payments/multi-chain/),
[Events](/making-payments/events/), and [Wallets by family](/making-payments/wallets-by-family/).

## Spend controls

The policy + ledger primitives. `evaluatePolicy` is the pure decision function the client and
MCP both call before any spend.

| Export | Kind | Marked |
| --- | --- | --- |
| `evaluatePolicy` | fn | **Headline** |
| `PaymentPolicy`, `PaymentIntent`, `PolicyDecision`, `PolicyDenyCode` | type | — |
| `SpendRecord`, `SpendSummary`, `SpendAssetTotal` | type | — |

See [Payment policy](/spend-controls/payment-policy/),
[Time envelope](/spend-controls/time-envelope/),
[evaluatePolicy()](/spend-controls/evaluate-policy/), and
[Spend ledger](/spend-controls/spend-ledger/).

## Agent toolkit

`paymentTools(client)` returns the tool set an autonomous LLM drives; the renderers and guide
make a bound client legible to the model.

| Export | Kind | Marked |
| --- | --- | --- |
| `paymentTools` | fn | **Headline** |
| `AgentTool`, `ToolAnnotations` | type | — |
| `summarizePlan`, `explainDecline`, `formatSpendReport`, `describeChallenge` | fn | — |
| `PIPRAIL_AGENT_GUIDE`, `agentGuide` | const / fn | — |
| `classifyChallenge` | fn | — |
| `ChallengeTriage`, `ChallengeVerdict` | type | — |
| `buildSelfDescription`, `BRAND` | fn / const | the `extensions.piprail` self-description builder + brand single-source-of-truth |
| `SelfDescription`, `SelfDescribeRail` | type | — |

See [Payment tools](/agent-toolkit/payment-tools/), [The 7 tools](/agent-toolkit/the-7-tools/),
[Renderers](/agent-toolkit/renderers/), [Agent guide](/agent-toolkit/agent-guide/), and
[Challenge triage](/agent-toolkit/challenge-triage/).

## Chains

`CHAINS` is the built-in EVM mainnet registry (each preset carries its canonical token
addresses); `resolveChain` turns a `chain` value into a `ResolvedChain`.

| Export | Kind |
| --- | --- |
| `CHAINS`, `resolveChain` | const / fn |
| `ChainInput`, `ChainName`, `ResolvedChain` | type |
| `ChainPreset`, `TokenInfo` | type |

See [Chains overview](/chains/overview/) and [Chains & tokens](/concepts/chains-and-tokens/).

## Discovery

Be found, and find others — on the open x402 indexes, with nothing PipRail-hosted. The builders
are pure (emit static artifacts); the `register*` / `searchOpenIndexes` functions talk to the
free public directories.

| Export | Kind |
| --- | --- |
| `buildOpenApi`, `buildWellKnownX402`, `buildX402DnsTxt`, `buildBazaarExtension`, `GENERATOR` | fn / const |
| `discoveryHeaders`, `POWERED_BY`, `renderLandingPage` | fn / const | self-describing HTTP surfaces — the Link/`x-powered-by` header bag + the human HTML landing page |
| `searchOpenIndexes`, `register402Index`, `registerX402Scan` | fn |
| `claim402IndexDomain`, `verify402IndexDomain` | fn |
| `normalizeNetwork`, `getDirectoryInfo`, `decorateOutcome`, `DIRECTORY_INFO` | fn / const |
| `appendAttribution`, `REGISTER_ATTRIBUTION` | fn / const | the opt-in `· Built with @piprail/sdk` listing marker |
| `PaymentRail`, `ResourceDescription`, `ManifestInput` | type |
| `OpenApiDocument`, `OpenApiOperation`, `WellKnownX402`, `X402DnsRecord` | type |
| `DiscoveryDescriptor`, `BazaarExtension` | type |
| `DiscoverySource`, `DiscoveredRail`, `DiscoveredResource` | type |
| `RegisterOutcome`, `RegisterInput`, `SearchOpenIndexesOptions` | type |
| `DirectoryInfo`, `ListingVisibility`, `DomainClaim`, `DomainVerification` | type |
| `DiscoverOptions`, `RegisterOptions` | type |

See [Discover & register](/discovery/discover-and-register/),
[Open indexes](/discovery/open-indexes/), [Emitters](/discovery/emitters/), and
[Domain verification](/discovery/domain-verification/).

## Errors

Every thrown error is a typed `PipRailError` subclass with a stable `.code`.

| Export | Kind |
| --- | --- |
| `PipRailError` | class (base) |
| `InsufficientFundsError`, `RecipientNotReadyError` | class |
| `WrongChainError`, `WrongFamilyError`, `UnknownTokenError` | class |
| `MissingDriverError`, `UnsupportedNetworkError`, `UnsupportedSchemeError` | class |
| `PaymentTimeoutError`, `ConfirmationTimeoutError`, `MaxRetriesExceededError` | class |
| `PaymentDeclinedError`, `InvalidEnvelopeError`, `NoCompatibleAcceptError` | class |
| `NonReplayableBodyError`, `SettlementError`, `WalletRequiredError` | class |
| `toInsufficientFundsError` | fn |
| `DeclineReasonCode` | type |

See [Error model](/errors/error-model/), [Error hierarchy](/errors/error-hierarchy/),
[VerifyErrorCode](/errors/verify-error-code/), and [Why payments fail](/errors/why-payments-fail/).

## Advanced: wire codecs

The raw envelope codecs, for building a client or server by hand. `PipRailClient` and
`createPaymentGate` cover the 99% case — reach for these only when you're hand-rolling the wire
format (server: `buildChallengeHeader` → verify → `buildReceiptHeader`; client: `parseChallenge`
→ `buildSignatureHeader` → `parseReceipt`).

| Export | Kind |
| --- | --- |
| `pickAccept` | fn |
| `parseChallenge`, `parseReceipt`, `parseSettleResponse` | fn |
| `parseSignatureHeader`, `parseExactPaymentHeader` | fn |
| `buildChallengeHeader`, `buildSignatureHeader`, `buildExactSignatureHeader`, `buildReceiptHeader` | fn |
| `HEADER_REQUIRED`, `HEADER_SIGNATURE`, `HEADER_RESPONSE`, `HEADER_SIGNATURE_V1`, `HEADER_RESPONSE_V1` | const |
| `Caip2`, `AssetId`, `AddressId` | type |
| `VerifyResult`, `VerifyErrorCode` | type |
| `X402AcceptEntry`, `X402ExactAcceptEntry`, `X402AnyAccept`, `X402Challenge` | type |
| `X402PaymentSignature`, `X402Receipt`, `X402ResourceObject`, `SettleOutcome` | type |
| `ExactAuthorizationWire`, `ExactPaymentPayload`, `ParsedExactPayment` | type |

See [Wire codecs](/reference/wire-codecs/) and [VerifyErrorCode](/errors/verify-error-code/).

## Advanced: low-level exact (EVM — EIP-3009 + Permit2)

The standard x402 `exact` scheme at the codec tier. For the high-level paths use
`PipRailClient({ schemes: ['exact'] })` (buyer) or `createPaymentGate({ exact })` (seller) — these
exports are for hand-rolled clients, v1 servers, and custom flows. The `exact` scheme has three
asset-transfer methods: **EIP-3009** (`transferWithAuthorization`, on EVM tokens that implement it),
**Permit2** (for EVM ERC-20s that don't — e.g. Binance-Peg USDC/USDT on BNB), and **SVM** (Solana —
any SPL token, the merchant is the fee payer). The codecs below are the EVM tier; the Solana payload is
the `{ transaction }` shape (`ExactSvmPaymentPayload`) and is built/verified inside the Solana driver.
See [Gasless payments](/making-payments/gasless-payments/).

| Export | Kind | Note |
| --- | --- | --- |
| `parseExactRequirements`, `chainIdForExactNetwork`, `encodeXPaymentHeader` | fn | EVM tier |
| `readExactDomain`, `eip3009Abi` | fn / const | reads/uses a token's true on-chain EIP-712 domain (EVM) |
| `EXACT_NETWORK_SLUGS`, `EIP3009_TYPES` | const | — |
| `PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES` | const | Permit2 method: the canonical Permit2 + x402ExactPermit2Proxy + witness types |
| `PERMIT2_PROXY_CHAIN_IDS`, `isPermit2ProxyChain` | const / fn | EVM chains where the x402 Permit2 proxy is deployed (where the Permit2 exact method can settle) |
| `buildExactAuthorization` | fn | Deprecated — trusts the server-supplied domain |
| `ExactAccept`, `ExactAuthorization`, `BuildExactParams` | type | — |
| `Permit2Authorization`, `Permit2PaymentPayload`, `ExactPaymentPayloadAny` | type | the per-method wire payloads (EIP-3009 / Permit2 / SVM); `ParsedExactPayment` is a union on `method` (`'eip3009'`/`'permit2'`/`'svm'`) |

## Advanced: exact facilitator (Mode B) — `facilitator.js`

The Mode-B facilitator path (`createPaymentGate({ exact: { settle: { facilitator } } })`) delegates
verify + settle to a third-party facilitator you choose. PipRail hosts nothing.

| Export | Kind | Note |
| --- | --- | --- |
| `settleViaFacilitator` | fn | Run the two-POST verify→settle contract against a facilitator URL. |
| `parseFacilitatorSupported`, `facilitatorCoverage` | fn | Read a facilitator's `GET /supported` → which (scheme, network) pairs it settles (never throws). |
| `KNOWN_FACILITATORS`, `knownFacilitatorsFor`, `firstKeylessFacilitator` | const / fn | The keyless-facilitator coverage data map (which keyless facilitator settles `exact` on a network). |
| `FacilitatorConfig` | type | The facilitator's base `url` + optional `authHeaders` provider. |
| `FacilitatorPaymentRequirements` | type | The trusted `exact` requirements posted to the facilitator. |
| `SettleViaFacilitatorInput`, `FacilitatorSupportedKind`, `KnownFacilitator` | type | input to `settleViaFacilitator`; the `/supported` kinds; a coverage-map entry. |

See the [exact rail (seller)](/accepting-payments/exact-rail-seller/) page for how to wire it, and
[Facilitator coverage](/accepting-payments/facilitator-coverage/) for the keyless-facilitator data map.

See [Low-level exact](/reference/exact-lowlevel/),
[exact rail (seller)](/accepting-payments/exact-rail-seller/), and
[exact (buyer)](/making-payments/exact-buyer/).

## Advanced: driver SPI

Bring your own chain family. `registerDriver` adds a family that implements the `PaymentDriver`
contract; the rest are the contract's types.

| Export | Kind |
| --- | --- |
| `registerDriver` | fn |
| `PaymentDriver`, `ChainFamily` | type |
| `ResolvedNetwork`, `ResolveOptions`, `ResolvedToken`, `CostEstimate` | type |
| `WalletHandle`, `WalletBalance`, `DiscoverySigner`, `ConfirmInfo` | type |
| `RecipientReason` | type |
| `EvmToken`, `SolanaToken`, `TonToken`, `StellarToken`, `XrplToken` | type |
| `TronToken`, `NearToken`, `SuiToken`, `AptosToken`, `AlgorandToken` | type |

See [Driver SPI](/reference/driver-spi/) and
[PaymentDriver architecture](/concepts/payment-driver-architecture/).

:::note
The public API is exactly what `@piprail/sdk` re-exports from its entry point. Anything reachable
only by deep-importing an internal module is not part of the contract and may change without a
major version bump.
:::
