// @piprail/sdk — accept x402 crypto payments on any EVM chain plus Solana,
// TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar & XRPL, in a couple of
// lines. No backend, no database, no fee — payments go straight to your
// wallet, verified locally against your own RPC.
//
//   ACCEPT  → requirePayment / createPaymentGate   (server side)
//   PAY     → PipRailClient                        (agent side)
//
// One parameter picks the chain: 'base' | 'bnb' | … (EVM), or a non-EVM
// family name ('solana', 'ton', 'tron', 'near', 'sui', 'aptos', 'algorand',
// 'stellar', 'xrpl'). Non-EVM drivers auto-mount on first use — no setup
// call — lazily importing only that family's peer libraries.

/* ----------------------------- pay (agent side) ----------------------------- */

export { PipRailClient, planAcross, fetchAcross } from './client.js'
export type {
  PipRailClientOptions,
  PipRailEvent,
  PipRailQuote,
  PipRailCostQuote,
  PaymentScheme,
  WalletInput,
  PaymentPlan,
  PayOption,
  PayBlocker,
  PayWarning,
  SessionBudget,
  SpendRemaining,
  DenomRemaining,
  CountStatus,
  PayingClient,
  ReceiptVerification,
} from './client.js'

// Multi-chain buying: one buyer, one wallet per chain, auto-route to whichever
// chain/token the 402 asks for. A thin, chain-agnostic wrapper over planAcross +
// fetchAcross; satisfies PayingClient so the agent toolkit + MCP wrap it unchanged.
export { MultiChainPayer } from './payer.js'
export type { MultiChainPayerOptions } from './payer.js'

/* ---------------------- agent spend controls (Tier 1) ---------------------- */

export type { PaymentPolicy, PaymentIntent, PolicyDecision, PolicyDenyCode } from './policy.js'
// `denomOf`/`BUILTIN_DENOMS`/`DENOM_PRECISION` back the cross-token grand total
// (`maxTotalPerDenom`) — a unit-of-account sum, NOT a price oracle. Exported so a
// caller can introspect or extend the denomination map.
export { evaluatePolicy, denomOf, BUILTIN_DENOMS, DENOM_PRECISION } from './policy.js'
// SpendLedger is exported so several single-chain clients can SHARE one (a cross-chain
// grand total / count cap). `MultiChainPayer.fromWallets` does this for you.
export { SpendLedger } from './ledger.js'
export type {
  SpendRecord,
  SpendSummary,
  SpendAssetTotal,
  SpendDenomTotal,
} from './ledger.js'
// Durable spend store — make the budget survive a restart. The interface + the in-memory
// store are browser-safe here; the Node file store is `fileSpendStore` from `@piprail/sdk/node`.
export { memorySpendStore } from './spendstore.js'
export type { SpendStore } from './spendstore.js'

/* ----------------------- agent toolkit (Tier 2) ----------------------- */

export { paymentTools } from './agent.js'
export type { AgentTool, ToolAnnotations } from './agent.js'

/* ---- agent ergonomics (Tier 3): NL renderers, the guide, scheme triage ---- */

// Pure, chain-free helpers that make a bound client legible to an autonomous LLM:
// one-line plan/decline/spend renderers, the cross-tool contract string, and a
// 402 scheme/chain triage. The MCP wires these into its tool outputs + a prompt.
export { summarizePlan, explainDecline, formatSpendReport, describeChallenge } from './render.js'
export { PIPRAIL_AGENT_GUIDE, agentGuide } from './agentGuide.js'
export { classifyChallenge } from './classify.js'
export type { ChallengeTriage, ChallengeVerdict } from './classify.js'
// Self-description — the pure builder for the `extensions.piprail` block + the brand
// single-source-of-truth (discoverability plan Phase 1; wired into the gate in Phase 5).
export { buildSelfDescription, buildEndpointInfo, BRAND } from './selfdescribe.js'
export type { SelfDescription, SelfDescribeRail, SelfDescribeEndpoint } from './selfdescribe.js'

/* --------------------------- accept (server side) --------------------------- */

export { requirePayment, createPaymentGate, toInvalidBody } from './server.js'
export type {
  RequirePaymentOptions,
  ReceiptOption,
  AcceptOption,
  ExactRailOption,
  UptoRailOption,
  FailedPayment,
  ChainSelector,
  TokenInput,
  PaymentGate,
  GateSelfTest,
  VerifyPaymentResult,
  X402InvalidBody,
  ExpressLikeRequest,
  ExpressLikeResponse,
  ExpressLikeNext,
  ExpressLikeMiddleware,
} from './server.js'

/* ------------------- merchant presets + framework adapters (server side) ------------------- */

// Named, batteries-included sugar over `createPaymentGate` — say WHAT you're selling, not how to
// wire a gate. Each resolves to a standard gate, so its 402 is byte-identical to the hand-written
// equivalent. `token` defaults to USDC; every other gate option still works.
export { createPaywall, createTipJar } from './merchant.js'
export type { PaywallOptions, TipJarOptions } from './merchant.js'
// Two framework adapters cover every `fetch`-based runtime: `toFetchHandler` is the universal
// `(request, …) => Response` (Next.js, Netlify, Bun, Deno, Vercel, Hono, Lambda — any request-in/
// response-out handler), `toWorker` is the `{ fetch }` export object (Cloudflare / Service Workers).
// Both read the proof header in and write the right 402/200 + headers out (502 on a SettlementError),
// forwarding any extra runtime args (env/ctx/params) to your handler. Express keeps `requirePayment`.
export { toFetchHandler, toWorker, proxyTo } from './adapters.js'
export type { Serve } from './adapters.js'

/* --------------- standard `exact` rail: Mode-B facilitator (server side) --------------- */

// Delegate a standard `exact` payment's verify+settle to a THIRD-PARTY facilitator
// the MERCHANT chooses (Coinbase CDP, x402.org, …). Pure fetch — PipRail hosts
// nothing. `createPaymentGate({ exact: { settle: { facilitator } } })` uses this.
export { settleViaFacilitator, parseFacilitatorSupported, facilitatorCoverage } from './facilitator.js'
export type {
  FacilitatorConfig,
  FacilitatorPaymentRequirements,
  SettleViaFacilitatorInput,
  FacilitatorSupportedKind,
} from './facilitator.js'
// Facilitator-coverage DATA map (discoverability plan Phase 4) — which keyless facilitators
// settle `exact` on which networks; powers the `exact: true` shorthand (Phase 7). Pure data.
export { KNOWN_FACILITATORS, knownFacilitatorsFor, firstKeylessFacilitator } from './facilitators.js'
export type { KnownFacilitator } from './facilitators.js'

/* --------------------- reliable receipt delivery (server side) --------------------- */

// A durable webhook a stateless gate can't be: POST a settled PaidReceipt to YOUR
// endpoint with retries + HMAC signature + idempotency key. Never throws. Use it as
// the body of an `onPaid` hook. PipRail hosts nothing — the URL is your server.
export { deliverReceipt } from './receipts.js'
export type { DeliverReceiptOptions, DeliverAttempt, DeliverResult } from './receipts.js'

/* ------------------------------- chains ------------------------------- */

// CHAINS = the built-in EVM mainnet registry. Iterate it for a chain picker,
// or read a token address straight out of it.
export { CHAINS, resolveChain } from './drivers/evm/chains.js'
export type {
  ChainInput,
  ChainName,
  ResolvedChain,
  ChainPreset,
  TokenInfo,
} from './drivers/evm/chains.js'

/* ----------------- driver SPI (bring your own chain family) ----------------- */

export { registerDriver } from './drivers/index.js'
export type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  CostEstimate,
  WalletHandle,
  DiscoverySigner,
  ConfirmInfo,
  ChainFamily,
  EvmToken,
  SolanaToken,
  TonToken,
  StellarToken,
  XrplToken,
  TronToken,
  SuiToken,
  NearToken,
  AptosToken,
  AlgorandToken,
  RecipientReason,
  WalletBalance,
  ReceiptInput,
} from './drivers/types.js'

/* ----------------------------- errors ----------------------------- */

export {
  PipRailError,
  InsufficientFundsError,
  RecipientNotReadyError,
  WrongChainError,
  WrongFamilyError,
  UnknownTokenError,
  MissingDriverError,
  UnsupportedNetworkError,
  PaymentTimeoutError,
  ConfirmationTimeoutError,
  MaxRetriesExceededError,
  PaymentDeclinedError,
  InvalidEnvelopeError,
  InvalidConfigError,
  NoCompatibleAcceptError,
  UnsupportedSchemeError,
  NonReplayableBodyError,
  WalletRequiredError,
  SettlementError,
  toInsufficientFundsError,
} from './errors.js'
export type { DeclineReasonCode } from './errors.js'

/* ------------------- wire format (for hand-rolled clients/servers) ------------------- */

// High-level PipRailClient / createPaymentGate cover the 99% case. These are
// the raw envelope codecs for building a client or server by hand:
//   server: buildChallengeHeader → (verify) → buildReceiptHeader
//   client: parseChallenge → buildSignatureHeader → parseReceipt
export {
  pickAccept,
  parseChallenge,
  parseReceipt,
  parseReceiptExtension,
  parseSettleResponse,
  parseSignatureHeader,
  parseExactPaymentHeader,
  parseUptoPaymentHeader,
  // Object-accepting parser CORES (the base64 wrappers above call these) — for a transport
  // that carries the SAME payload as RAW JSON (A2A), fed via `gate.verifyObject`.
  parseSignatureObject,
  parseExactObject,
  parseUptoObject,
  decodeBase64Json,
  buildChallengeHeader,
  buildSignatureHeader,
  buildExactSignatureHeader,
  buildUptoSignatureHeader,
  buildReceiptHeader,
  buildReceiptExtension,
  EXT_OFFER_RECEIPT,
  buildPaymentIdentifierAdvertisement,
  readPaymentIdentifier,
  EXT_PAYMENT_IDENTIFIER,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  HEADER_SIGNATURE_V1,
  HEADER_RESPONSE_V1,
} from './x402.js'
export type {
  Caip2,
  AssetId,
  AddressId,
  VerifyResult,
  VerifyErrorCode,
  X402AcceptEntry,
  X402ExactAcceptEntry,
  X402UptoAcceptEntry,
  X402AnyAccept,
  X402Challenge,
  X402PaymentSignature,
  X402Receipt,
  PaidReceipt,
  PipRailReceipt,
  SignedReceipt,
  X402ResourceObject,
  SettleOutcome,
  ExactAuthorizationWire,
  ExactPaymentPayload,
  ExactPaymentPayloadAny,
  Permit2Authorization,
  Permit2PaymentPayload,
  Permit2UptoAuthorization,
  Permit2UptoPaymentPayload,
  ParsedExactPayment,
  ParsedUptoPayment,
} from './x402.js'

/* ------------- x402 `exact`-scheme interop (EVM, EIP-3009) ------------- */

// The standard x402 `exact` scheme, BOTH directions. The HIGH-LEVEL paths are
// `PipRailClient({ schemes: ['exact'] })` (BUYER — pay any standard x402 server) and
// `createPaymentGate({ exact: … })` (SELLER — get paid via `exact`). The exports below are
// the LOW-LEVEL codec tier (hand-rolled clients, v1 servers, custom flows) — not needed for
// the high-level paths. `readExactDomain` reads a token's true on-chain EIP-712 domain;
// `eip3009Abi` is the minimal seller ABI. NOTE: `buildExactAuthorization` is @deprecated
// (trusts the server-supplied domain; local-key only) — the client uses `payExact`/`payExactEvm`.
export {
  parseExactRequirements,
  chainIdForExactNetwork,
  buildExactAuthorization,
  encodeXPaymentHeader,
  readExactDomain,
  eip3009Abi,
  EXACT_NETWORK_SLUGS,
  EIP3009_TYPES,
} from './drivers/evm/exact.js'
export type { ExactAccept, ExactAuthorization, BuildExactParams } from './drivers/evm/exact.js'

/* ----- x402 `exact`-scheme `permit2` variant (EVM, for non-EIP-3009 tokens — e.g. BNB) ----- */

// The `permit2` asset-transfer method of the x402 `exact` scheme — for ERC-20s WITHOUT
// EIP-3009 (Binance-Peg USDC/USDT on BNB Chain). High-level usage is unchanged
// (`PipRailClient({ schemes: ['exact'] })` BUYER / `createPaymentGate({ exact: … })` SELLER);
// these are the canonical addresses + the EIP-712 type set, for reference/advanced use. The
// proxy is BOTH the signature `spender` and the seller's settle contract (canonical CREATE2,
// every EVM chain), and it binds `witness.to` so funds can only reach the signed recipient.
export {
  PERMIT2_ADDRESS,
  X402_EXACT_PERMIT2_PROXY,
  PERMIT2_WITNESS_TYPES,
  PERMIT2_PROXY_CHAIN_IDS,
  isPermit2ProxyChain,
} from './drivers/evm/permit2.js'

/* ----- x402 `upto`-scheme `permit2` variant (EVM, metered / variable-amount billing) ----- */

// The `upto` (metered) scheme — buyer signs a Permit2 witness transfer for a MAX, merchant
// settles the ACTUAL (≤ max) after serving. EVM-Permit2 ONLY. High-level usage:
// `createPaymentGate({ upto: { relayer, settleAmount } })` SELLER (the supported handler shape
// is a direct `gate.verify()` call that meters inside `settleAmount` — `requirePayment` is
// UNSUPPORTED for upto) / `PipRailClient({ schemes: ['onchain-proof', 'upto'] })` BUYER. The
// proxy (vanity `…0002`, distinct from the exact `…0001`) is BOTH the signature `spender` and
// the seller's settle contract, and the witness's MIDDLE `facilitator` field binds who may settle.
export {
  X402_UPTO_PERMIT2_PROXY,
  PERMIT2_UPTO_WITNESS_TYPES,
  UPTO_PROXY_CHAIN_IDS,
  isUptoProxyChain,
} from './drivers/evm/upto.js'

/* ------------------- discovery (find + be found, $0, no backend) ------------------- */

// Make a gated resource discoverable on the OPEN x402 indexes — nothing
// PipRail-hosted. Three moves:
//   EMIT     buildOpenApi / buildWellKnownX402 / buildX402DnsTxt (pure) +
//            gate.describe() — the static artifacts a crawler reads.
//   REGISTER client.register(url) → 402 Index (no auth) [+ x402scan SIWX].
//   DISCOVER client.discover({ query }) → read CDP Bazaar + 402 Index (free).
// The piprail_discover / piprail_register agent tools expose this to an LLM/MCP.
export { buildOpenApi, buildWellKnownX402, buildWellKnownX402Manifest, buildX402DnsTxt, buildBazaarExtension, GENERATOR } from './discovery.js'
// Self-describing HTTP surfaces (discoverability plan Phase 2): the Link/x-powered-by header
// bag + the human HTML landing page. Pure — the merchant serves them; the SDK serves nothing.
export { discoveryHeaders, POWERED_BY } from './discovery.js'
export { renderLandingPage } from './landing.js'
export type {
  PaymentRail,
  ResourceDescription,
  ManifestInput,
  OpenApiDocument,
  OpenApiOperation,
  WellKnownX402,
  WellKnownX402Manifest,
  WellKnownX402Item,
  X402DnsRecord,
  DiscoveryDescriptor,
  BazaarExtension,
} from './discovery.js'
export {
  searchOpenIndexes,
  register402Index,
  registerX402Scan,
  claim402IndexDomain,
  verify402IndexDomain,
  normalizeNetwork,
  DIRECTORY_INFO,
  getDirectoryInfo,
  decorateOutcome,
  appendAttribution,
  appendKeywords,
  rankResources,
  scoreResource,
  REGISTER_ATTRIBUTION,
} from './indexes.js'
export type {
  DiscoverySource,
  DiscoverySort,
  DiscoveredRail,
  DiscoveredResource,
  RegisterOutcome,
  RegisterInput,
  SearchOpenIndexesOptions,
  DirectoryInfo,
  ListingVisibility,
  DomainClaim,
  DomainVerification,
} from './indexes.js'
export type { DiscoverOptions, RegisterOptions } from './client.js'

/* ------------------- A2A transport (x402 over Google Agent2Agent) ------------------- */

// The SELLER-side A2A adapter — the A2A analogue of `requirePayment`. Wrap a PaymentGate
// and map A2A `Task`/`Message` metadata ⇄ x402's existing envelopes, backendless. ZERO
// driver/scheme/chain changes — every family rides A2A for free. `verifyObject` (the raw-JSON
// dispatch seam it relies on) is on the already-exported `PaymentGate`. The A2A BUYER
// (`A2APayer`) + AP2 Embedded Flow are deferred (see the transport module's header).
export {
  createA2APaymentHandler,
  toA2APaymentRequired,
  toA2APaymentReceipts,
  toA2APaymentFailed,
  fromA2APaymentRequired,
  fromA2APaymentPayload,
  toA2AErrorCode,
  VERIFY_CODE_TO_A2A_ERROR,
  A2A_X402_EXTENSION_URI_V01,
  A2A_X402_EXTENSION_URI_V02,
  A2A_STATUS_KEY,
  A2A_REQUIRED_KEY,
  A2A_PAYLOAD_KEY,
  A2A_RECEIPTS_KEY,
  A2A_ERROR_KEY,
  A2A_EXTENSIONS_HEADER,
} from './transports/a2a.js'
export type {
  A2APaymentHandler,
  A2APaymentHandlerOptions,
} from './transports/a2a.js'
export type {
  A2AArtifact,
  A2AExtensionDeclaration,
  A2AMessage,
  A2AMetadata,
  A2APart,
  A2APaymentStatus,
  A2ATask,
  A2ATaskRecord,
  A2ATaskState,
  A2ATaskStore,
} from './transports/a2a-types.js'

// ── x402-over-MCP transport ─────────────────────────────────────────────────
// The third official x402 transport: x402 carried over MCP TOOL CALLS (a 402 as an `isError`
// tool result, the payment under `_meta["x402/payment"]`, the settlement under
// `_meta["x402/payment-response"]`). A thin re-keying of the gate's `verifyObject` onto the MCP
// message shape — zero driver/scheme/chain changes; every family rides MCP for free. The seller
// (`createMcpPaymentTool`) + the pure codec + the buyer READ/FRAME helpers ship; a fully-automatic
// `McpPayer` (driving the client pay path) is a fast-follow, as A2A shipped seller-first.
export {
  createMcpPaymentTool,
  toMcpPaymentRequired,
  toMcpPaymentResponse,
  fromMcpPayment,
  fromMcpPaymentRequired,
  fromMcpPaymentResponse,
  isMcpPaymentRequired,
  buildMcpPaymentMeta,
} from './transports/mcp.js'
export {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
} from './transports/mcp-types.js'
export type {
  McpPaymentTool,
  McpPaymentToolOptions,
} from './transports/mcp.js'
export type {
  McpContentBlock,
  McpToolCallParams,
  McpToolResult,
  McpPaymentMeta,
} from './transports/mcp-types.js'
