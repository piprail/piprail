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
| `createPaywall`, `createTipJar` | fn | Presets — named sugar over `createPaymentGate` (fixed-price paywall / pay-what-you-want tip jar). See [Presets & self-test](/accepting-payments/merchant-presets/) |
| `toFetchHandler`, `toWorker` | fn | Two adapters cover every `fetch` runtime — `toFetchHandler` (the universal `(request, …) => Response`: Next.js, Netlify, Bun, Deno, Vercel, Hono, Lambda) + `toWorker` (the `{ fetch }` export: Cloudflare / Service Workers). See [Framework adapters](/accepting-payments/framework-adapters/) |
| `deliverReceipt` | fn | Reliable receipt webhook — signed + retried POST to **your** endpoint |
| `toInvalidBody` | fn | Deprecated |
| `RequirePaymentOptions`, `AcceptOption`, `ExactRailOption` | type | carries `onPaid` / `onPaidError` / `awaitOnPaid` **and their failure mirrors `onFailed` / `onFailedError` / `awaitOnFailed`**; `mimeType` (→ v2 `resource.mimeType` + the self-describe `endpoint`) |
| `UptoRailOption` | type | The `createPaymentGate({ upto })` rail option — metered / variable-amount billing (buyer signs a MAX, you settle the actual ≤ max). See [upto rail (seller)](/accepting-payments/upto-rail-seller/) |
| `ReceiptOption` | type | The `createPaymentGate({ receipt })` rail option — emit a signed, anyone-verifiable [verifiable receipt](/accepting-payments/verifiable-receipts/) alongside the response |
| `ChainSelector`, `TokenInput` | type | — |
| `PaymentGate`, `VerifyPaymentResult` | type | — |
| `GateSelfTest` | type | The result of `gate.selfTest()` — `{ ok, rails, warnings, error? }` (read-only, never-throw config check) |
| `PaywallOptions`, `TipJarOptions`, `Serve` | type | The preset + adapter option types |
| `PaidReceipt` | type | The enriched receipt `onPaid` receives |
| `FailedPayment` | type | The failure object `onFailed` receives — `{ code, detail, transient }` (the mirror of `PaidReceipt`) |
| `DeliverReceiptOptions`, `DeliverAttempt`, `DeliverResult` | type | — |
| `X402InvalidBody` | type | — |
| `ExpressLike{Request,Response,Next,Middleware}` | type | — |

See [requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/),
[Defining accepts](/accepting-payments/defining-accepts/),
[Verifying payments](/accepting-payments/verifying-payments/), and
[Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) (the `PaidReceipt`, `onPaidError`,
`awaitOnPaid`, and `deliverReceipt` — plus the failure mirror `onFailed` / `FailedPayment` /
`onFailedError` / `awaitOnFailed`, fired when a submitted proof is rejected).

:::note
`onFailed` is the exact mirror of `onPaid`: it fires only when a SUBMITTED proof is **rejected**
(a `kind:'invalid'` verdict from `gate.verify()` — wrong amount, expired, replayed, unknown asset,
wrong recipient, bad signature, …), never on a normal no-proof first-request 402 and never when
`verify()` *throws* (a transient RPC blip or a 5xx `SettlementError` isn't a verdict). The
`FailedPayment` it receives carries the SAME machine `code` the buyer's client is told, so both
sides see one consistent reason. `transient` is `true` only for the two transient codes
(`tx_not_found` / `insufficient_confirmations`) — the proof may still be settling and the buyer
auto-retries, so alert on `!transient`. See
[Why payments fail](/errors/why-payments-fail/) and [VerifyErrorCode](/errors/verify-error-code/).
:::

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
| `PipRailQuote`, `PipRailCostQuote`, `PipRailEvent` | type | the `payment-failed` event gained `code?` / `detail?` and ALSO fires on a pre-send DECLINE (policy / `onBeforePay` / no settleable rail) |
| `PaymentPlan`, `PayOption`, `PayBlocker`, `PayWarning` | type | — |
| `SessionBudget`, `SpendRemaining` | type | — |
| `ReceiptVerification` | type | The verdict returned by the static `PipRailClient.verifyReceipt` / `PipRailClient.verifyAttestation` — re-verify a [verifiable receipt](/making-payments/verifying-receipts/) against the chain, wallet-free (never throws). `client.lastReceipt()` returns the most recent one the client received. |

See [Quote](/making-payments/quote/), [Estimate cost](/making-payments/estimate-cost/),
[planPayment()](/making-payments/plan-payment/),
[fetch & autoRoute](/making-payments/fetch-and-autoroute/),
[Multi-chain buying](/making-payments/multi-chain/),
[Events](/making-payments/events/), and [Wallets by family](/making-payments/wallets-by-family/).

:::tip
The `payment-failed` event (on `onEvent`) now carries an optional `code?` + `detail?`. On a
**server rejection** that's the SAME canonical `code` the merchant's `onFailed` hook receives (a
[VerifyErrorCode](/errors/verify-error-code/)); on a **pre-send client decline** it's the decline
reason (e.g. `'BUDGET'` / `'APPROVAL'` / `'MAX_AMOUNT'`). `payment-failed` also fires on those
pre-send declines now (policy, `onBeforePay`, or no settleable rail) — previously those *only*
threw. The typed `PaymentDeclinedError` throw is unchanged and zero funds still move, so a consumer
watching `onEvent` alone now learns of **every** failure type, not just server rejections. See
[Events](/making-payments/events/).
:::

## Spend controls

The policy + ledger primitives. `evaluatePolicy` is the pure decision function the client and
MCP both call before any spend. The ledger + store are how caps survive a restart and span chains
— still no backend, no database, no fee: `SpendLedger` is in-memory and a `SpendStore` is a
caller-owned file (or anything you implement).

| Export | Kind | Marked |
| --- | --- | --- |
| `evaluatePolicy` | fn | **Headline** |
| `SpendLedger` | class | Share one across several clients for a cross-chain grand total (`MultiChainPayer.fromWallets` wires it for you) |
| `memorySpendStore` | fn | A `SpendStore` backed by an in-memory array — `memorySpendStore(seed?)`; from `@piprail/sdk` |
| `fileSpendStore` | fn | A durable JSONL `SpendStore` — `fileSpendStore(path)`; from `@piprail/sdk/node` (Node-only, keeps `node:fs` out of the browser bundle) |
| `denomOf` | fn | Pure — `denomOf(symbol, asset, policy)` → the unit a token folds into, or none |
| `BUILTIN_DENOMS`, `DENOM_PRECISION` | const | the built-in symbol→unit map (USDC/USDT/USD1/FDUSD/U/RLUSD → `'USD'`, EURC → `'EUR'`) and the fixed-point precision (`24`) |
| `PaymentPolicy`, `PaymentIntent`, `PolicyDecision`, `PolicyDenyCode` | type | `PaymentPolicy` gained `maxTotalPerDenom` / `denomFor` / `maxPayments` / `maxPaymentsPerWindow` / `warnAtFraction`; `PolicyDenyCode` gained `MAX_TOTAL_DENOM` / `MAX_PAYMENTS` / `WINDOW_COUNT` |
| `SpendStore` | type | `{ load(): SpendRecord[]; append(record): void }` — pass as the client's `spendStore` to persist the ledger (never throws) |
| `SpendRecord`, `SpendSummary`, `SpendAssetTotal`, `SpendDenomTotal` | type | `SpendSummary` gained `byDenom: SpendDenomTotal[]`; `SpendRecord` gained optional `decimals` / `denom` |
| `DenomRemaining`, `CountStatus` | type | the per-denomination remaining row + the payment-count status `SessionBudget` now also reports |

See [Payment policy](/spend-controls/payment-policy/),
[Total budget](/spend-controls/total-budget/),
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
| `buildSelfDescription`, `buildEndpointInfo`, `BRAND` | fn / const | the `extensions.piprail` self-description builder, the `endpoint` sub-block assembler, + brand single-source-of-truth |
| `SelfDescription`, `SelfDescribeRail`, `SelfDescribeEndpoint` | type | the self-describe block, a rail in it, and the agent-readable `endpoint` (summary/input/output) |

See [Payment tools](/agent-toolkit/payment-tools/), [The agent tools](/agent-toolkit/the-agent-tools/),
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
| `buildOpenApi`, `buildWellKnownX402`, `buildWellKnownX402Manifest`, `buildX402DnsTxt`, `buildBazaarExtension`, `GENERATOR` | fn / const | `buildWellKnownX402Manifest` emits the forward-compatible `/.well-known/x402.json` (a richer second artifact beside the legacy flat `buildWellKnownX402`); takes `ManifestInput & { lastUpdated?: number }` |
| `discoveryHeaders`, `POWERED_BY`, `renderLandingPage` | fn / const | self-describing HTTP surfaces — the Link/`x-powered-by` header bag + the human HTML landing page |
| `searchOpenIndexes`, `register402Index`, `registerX402Scan` | fn |
| `claim402IndexDomain`, `verify402IndexDomain` | fn |
| `normalizeNetwork`, `getDirectoryInfo`, `decorateOutcome`, `DIRECTORY_INFO` | fn / const |
| `rankResources`, `scoreResource` | fn | client-side relevance ranking of merged results (the engine behind a multi-word `discover()` query) |
| `appendKeywords` | fn | fold `tags` into a description as a searchable `· Keywords: …` tail (402 Index search is literal) |
| `appendAttribution`, `REGISTER_ATTRIBUTION` | fn / const | the opt-in `· Built with @piprail/sdk` listing marker |
| `PaymentRail`, `ResourceDescription`, `ManifestInput` | type | `ResourceDescription` carries an optional `mimeType` (v2 ResourceInfo) |
| `OpenApiDocument`, `OpenApiOperation`, `WellKnownX402`, `WellKnownX402Manifest`, `WellKnownX402Item`, `X402DnsRecord` | type |
| `DiscoveryDescriptor`, `BazaarExtension` | type | `DiscoveryDescriptor` gained `summary` — feeds both `extensions.bazaar` and `extensions.piprail.endpoint` |
| `DiscoverySource`, `DiscoverySort`, `DiscoveredRail`, `DiscoveredResource` | type | `DiscoveredResource` gained `tags` / `reliabilityScore` / `health` / `verified` / `score` |
| `RegisterOutcome`, `RegisterInput`, `SearchOpenIndexesOptions` | type | `RegisterInput` + `SearchOpenIndexesOptions` gained the category / tags / asset / reliability / sort fields |
| `DirectoryInfo`, `ListingVisibility`, `DomainClaim`, `DomainVerification` | type |
| `DiscoverOptions`, `RegisterOptions` | type | `DiscoverOptions` gained category / asset / minReliability / verified / paymentValid / sort / order; `RegisterOptions` gained category / tags / provider / contactEmail / probeBody |

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
| `InvalidConfigError` | class |
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
| `parseChallenge`, `parseReceipt`, `parseReceiptExtension`, `parseSettleResponse` | fn |
| `parseSignatureHeader`, `parseExactPaymentHeader`, `parseUptoPaymentHeader` | fn |
| `parseSignatureObject`, `parseExactObject`, `parseUptoObject`, `decodeBase64Json` | fn — the object-accepting parser **cores** the base64 header parsers wrap, for a transport that carries the SAME payload as raw JSON (A2A), fed via `gate.verifyObject` |
| `buildChallengeHeader`, `buildSignatureHeader`, `buildExactSignatureHeader`, `buildUptoSignatureHeader`, `buildReceiptHeader` | fn |
| `buildReceiptExtension`, `EXT_OFFER_RECEIPT` | fn / const | build the `extensions.piprail.receipt` block (the anyone-verifiable [verifiable receipt](/accepting-payments/verifiable-receipts/)) + the offer-receipt extension key |
| `buildPaymentIdentifierAdvertisement`, `readPaymentIdentifier`, `EXT_PAYMENT_IDENTIFIER` | fn / const | the opt-in [`payment-identifier`](/accepting-payments/replay-protection/) idempotency extension — advertise it on a challenge (default OFF, `info.required:false`) and validate/dedupe an echoed `id` (16–128 chars, `[A-Za-z0-9_-]`) on the gate's used-proof set; `readPaymentIdentifier` returns the id \| `null` (absent) \| `{ invalid }` (malformed), never throws |
| `HEADER_REQUIRED`, `HEADER_SIGNATURE`, `HEADER_RESPONSE`, `HEADER_SIGNATURE_V1`, `HEADER_RESPONSE_V1` | const |
| `Caip2`, `AssetId`, `AddressId` | type |
| `VerifyResult`, `VerifyErrorCode` | type |
| `X402AcceptEntry`, `X402ExactAcceptEntry`, `X402UptoAcceptEntry`, `X402AnyAccept`, `X402Challenge` | type |
| `X402PaymentSignature`, `X402Receipt`, `X402ResourceObject`, `SettleOutcome` | type |
| `PipRailReceipt`, `SignedReceipt` | type | the [verifiable receipt](/making-payments/verifying-receipts/) envelope + its signed form |
| `ExactAuthorizationWire`, `ExactPaymentPayload`, `ExactPaymentPayloadAny`, `ParsedExactPayment` | type |
| `Permit2Authorization`, `Permit2PaymentPayload`, `Permit2UptoAuthorization`, `Permit2UptoPaymentPayload`, `ParsedUptoPayment` | type | the Permit2 `exact` + `upto` wire payloads |

See [Wire codecs](/reference/wire-codecs/) and [VerifyErrorCode](/errors/verify-error-code/).

## Advanced: low-level exact (EVM — EIP-3009 + Permit2)

The standard x402 `exact` scheme at the codec tier. For the high-level paths use
`PipRailClient({ schemes: ['exact'] })` (buyer) or `createPaymentGate({ exact })` (seller) — these
exports are for hand-rolled clients, v1 servers, and custom flows. The `exact` scheme has six
asset-transfer methods: **EIP-3009** (`transferWithAuthorization`, on EVM tokens that implement it) and
**Permit2** (for EVM ERC-20s that don't — e.g. Binance-Peg USDC/USDT on BNB), plus **SVM** (Solana —
any SPL token, the merchant is the fee payer), **Algorand**, **Aptos**, and **NEAR** on their respective
L1s. The codecs in the table below are the EVM tier (EIP-3009 + Permit2); the non-EVM payloads — SVM's
`{ transaction }` shape (`ExactSvmPaymentPayload`), Algorand (`ExactAlgorandPaymentPayload`), Aptos
(`ExactAptosPaymentPayload`), NEAR (`ExactNearPaymentPayload`) — are built/verified inside their
respective drivers — they are variants of the exported `ExactPaymentPayloadAny` union (reached via
`ParsedExactPayment`), not importable individually. See [Gasless payments](/making-payments/gasless-payments/).

| Export | Kind | Note |
| --- | --- | --- |
| `parseExactRequirements`, `chainIdForExactNetwork`, `encodeXPaymentHeader` | fn | EVM tier |
| `readExactDomain`, `eip3009Abi` | fn / const | reads/uses a token's true on-chain EIP-712 domain (EVM) |
| `EXACT_NETWORK_SLUGS`, `EIP3009_TYPES` | const | — |
| `PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES` | const | Permit2 method: the canonical Permit2 + x402ExactPermit2Proxy + witness types |
| `PERMIT2_PROXY_CHAIN_IDS`, `isPermit2ProxyChain` | const / fn | EVM chains where the x402 Permit2 proxy is deployed (where the Permit2 exact method can settle) |
| `buildExactAuthorization` | fn | Deprecated — trusts the server-supplied domain |
| `ExactAccept`, `ExactAuthorization`, `BuildExactParams` | type | — |
| `Permit2Authorization`, `Permit2PaymentPayload`, `ExactPaymentPayloadAny` | type | the per-method wire payloads (EIP-3009 / Permit2 / SVM / Algorand / Aptos / NEAR); `ParsedExactPayment` is a union on `method` (`'eip3009'`/`'permit2'`/`'svm'`/`'algorand'`/`'aptos'`/`'near'`) |

## Advanced: upto rail (EVM — metered / variable-amount Permit2)

The `upto` (metered) scheme — the buyer signs a Permit2 witness transfer for a **MAX**, and the
merchant settles the **actual** (≤ max) after serving. EVM-Permit2 **only**. The high-level paths are
`createPaymentGate({ upto })` (seller) and `PipRailClient({ schemes: ['onchain-proof', 'upto'] })`
(buyer) — these constants are the canonical proxy + witness types, for reference / advanced use. The
proxy (vanity `…0002`, distinct from the exact `…0001`) is BOTH the signature `spender` and the
seller's settle contract.

| Export | Kind | Note |
| --- | --- | --- |
| `X402_UPTO_PERMIT2_PROXY` | const | The canonical x402 `upto` Permit2 proxy address (vanity `…0002`). |
| `UPTO_PROXY_CHAIN_IDS`, `isUptoProxyChain` | const / fn | EVM chains where the `upto` Permit2 proxy is deployed (where the `upto` rail can settle). |
| `PERMIT2_UPTO_WITNESS_TYPES` | const | The EIP-712 witness type set for the `upto` Permit2 signature. |

See the [upto rail (seller)](/accepting-payments/upto-rail-seller/) page for how to wire it.

## Advanced: A2A transport (x402 over Google Agent2Agent)

The seller-side A2A adapter — the A2A analogue of `requirePayment`. Wrap a `PaymentGate` and map A2A
`Task`/`Message` metadata ⇄ x402's existing envelopes, backendless: zero driver/scheme/chain changes,
so every family rides A2A for free. The raw-JSON dispatch seam it relies on, `gate.verifyObject`, is a
method on the already-exported `PaymentGate`.

| Export | Kind | Note |
| --- | --- | --- |
| `createA2APaymentHandler` | fn | **Headline (A2A)** — wrap a `PaymentGate` into an A2A payment handler. |
| `toA2APaymentRequired`, `toA2APaymentReceipts`, `toA2APaymentFailed` | fn | Map an x402 challenge / receipts / failure **into** A2A `Task`/`Message` metadata. |
| `fromA2APaymentRequired`, `fromA2APaymentPayload` | fn | Read an A2A `payment-required` / payment payload back **out** of A2A metadata. |
| `toA2AErrorCode`, `VERIFY_CODE_TO_A2A_ERROR` | fn / const | Map a `VerifyErrorCode` to its A2A error code. |
| `A2A_X402_EXTENSION_URI_V01`, `A2A_X402_EXTENSION_URI_V02` | const | The x402-over-A2A extension URIs (v0.1 / v0.2). |
| `A2A_STATUS_KEY`, `A2A_REQUIRED_KEY`, `A2A_PAYLOAD_KEY`, `A2A_RECEIPTS_KEY`, `A2A_ERROR_KEY` | const | The A2A `metadata` keys the envelopes ride on. |
| `A2A_EXTENSIONS_HEADER` | const | The HTTP header that activates the A2A x402 extension. |
| `A2APaymentHandler`, `A2APaymentHandlerOptions` | type | the handler + its options |
| `A2AArtifact`, `A2AExtensionDeclaration`, `A2AMessage`, `A2AMetadata`, `A2APart`, `A2APaymentStatus`, `A2ATask`, `A2ATaskRecord`, `A2ATaskState`, `A2ATaskStore` | type | the A2A wire types |

See [A2A transport](/accepting-payments/a2a-transport/).

## Advanced: x402-over-MCP transport (the third official transport)

The seller-side MCP adapter — the MCP analogue of `requirePayment` / `createA2APaymentHandler`. Carry
x402's existing envelopes over MCP **tool calls** instead of HTTP headers, backendless: verify/settle/
replay all run through the gate's `verifyObject` (zero new crypto, zero driver/scheme/chain changes),
so every family rides MCP for free.

| Export | Kind | Note |
| --- | --- | --- |
| `createMcpPaymentTool` | fn | **Headline (MCP)** — wrap a `PaymentGate` as a paid MCP tool. A `fulfill()` throw *after* settle still returns a success `_meta` payment-response, never a re-challenge (B7 at-most-once). |
| `toMcpPaymentRequired`, `toMcpPaymentResponse` | fn | Build the 402-challenge (`isError` + `structuredContent` + a byte-equal `content[0].text`) and the settled tool result. |
| `fromMcpPayment`, `fromMcpPaymentRequired`, `fromMcpPaymentResponse`, `isMcpPaymentRequired` | fn | Buyer/seller read helpers — pull the payment / challenge / settlement out of an MCP message. |
| `buildMcpPaymentMeta` | fn | Frame an already-produced `{ accepted, payload }` into the retry call's `params._meta["x402/payment"]`. |
| `MCP_PAYMENT_META_KEY`, `MCP_PAYMENT_RESPONSE_META_KEY` | const | The spec `_meta` keys (`x402/payment` / `x402/payment-response` — a slash, not A2A's dot). |
| `McpPaymentTool`, `McpPaymentToolOptions`, `McpContentBlock`, `McpToolCallParams`, `McpToolResult`, `McpPaymentMeta` | type | the MCP wire types (duck-typed; zero `@modelcontextprotocol/sdk` dependency) |

A fully-automatic `McpPayer` (the buyer side) is a documented fast-follow, exactly as A2A shipped
seller-first. See [MCP transport (seller)](/accepting-payments/mcp-transport/).

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
| `ReceiptInput` | type |
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
