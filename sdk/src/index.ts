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

export { PipRailClient, planAcross } from './client.js'
export type {
  PipRailClientOptions,
  PipRailEvent,
  PipRailQuote,
  PipRailCostQuote,
  WalletInput,
  PaymentPlan,
  PayOption,
  PayBlocker,
  PayWarning,
} from './client.js'

/* ---------------------- agent spend controls (Tier 1) ---------------------- */

export type { PaymentPolicy, PaymentIntent, PolicyDecision } from './policy.js'
export { evaluatePolicy } from './policy.js'
export type {
  SpendRecord,
  SpendSummary,
  SpendAssetTotal,
} from './ledger.js'

/* ----------------------- agent toolkit (Tier 2) ----------------------- */

export { paymentTools } from './agent.js'
export type { AgentTool, ToolAnnotations } from './agent.js'

/* --------------------------- accept (server side) --------------------------- */

export { requirePayment, createPaymentGate, toInvalidBody } from './server.js'
export type {
  RequirePaymentOptions,
  AcceptOption,
  ExactRailOption,
  ChainSelector,
  TokenInput,
  PaymentGate,
  VerifyPaymentResult,
  X402InvalidBody,
  ExpressLikeRequest,
  ExpressLikeResponse,
  ExpressLikeNext,
  ExpressLikeMiddleware,
} from './server.js'

/* --------------- standard `exact` rail: Mode-B facilitator (server side) --------------- */

// Delegate a standard `exact` payment's verify+settle to a THIRD-PARTY facilitator
// the MERCHANT chooses (Coinbase CDP, x402.org, …). Pure fetch — PipRail hosts
// nothing. `createPaymentGate({ exact: { settle: { facilitator } } })` uses this.
export { settleViaFacilitator } from './facilitator.js'
export type {
  FacilitatorConfig,
  FacilitatorPaymentRequirements,
  SettleViaFacilitatorInput,
} from './facilitator.js'

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
  NoCompatibleAcceptError,
  NonReplayableBodyError,
  SettlementError,
  toInsufficientFundsError,
} from './errors.js'

/* ------------------- wire format (for hand-rolled clients/servers) ------------------- */

// High-level PipRailClient / createPaymentGate cover the 99% case. These are
// the raw envelope codecs for building a client or server by hand:
//   server: buildChallengeHeader → (verify) → buildReceiptHeader
//   client: parseChallenge → buildSignatureHeader → parseReceipt
export {
  pickAccept,
  parseChallenge,
  parseReceipt,
  parseSignatureHeader,
  parseExactPaymentHeader,
  buildChallengeHeader,
  buildSignatureHeader,
  buildReceiptHeader,
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
  X402AnyAccept,
  X402Challenge,
  X402PaymentSignature,
  X402Receipt,
  X402ResourceObject,
  ExactAuthorizationWire,
  ExactPaymentPayload,
  ParsedExactPayment,
} from './x402.js'

/* ------------- x402 `exact`-scheme interop (EVM, EIP-3009) ------------- */

// The standard x402 `exact` scheme, BOTH directions:
//  • BUYER  — building blocks to PAY a server speaking `exact` (EIP-3009 + facilitator),
//    making PipRail a universal x402 client. Not wired into PipRailClient's default.
//  • SELLER — get PAID via `exact` with `createPaymentGate({ exact: … })`. `readExactDomain`
//    reads a token's true EIP-712 domain; `eip3009Abi` is the minimal seller ABI.
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

/* ------------------- discovery (find + be found, $0, no backend) ------------------- */

// Make a gated resource discoverable on the OPEN x402 indexes — nothing
// PipRail-hosted. Three moves:
//   EMIT     buildOpenApi / buildWellKnownX402 / buildX402DnsTxt (pure) +
//            gate.describe() — the static artifacts a crawler reads.
//   REGISTER client.register(url) → 402 Index (no auth) [+ x402scan SIWX].
//   DISCOVER client.discover({ query }) → read CDP Bazaar + 402 Index (free).
// The piprail_discover / piprail_register agent tools expose this to an LLM/MCP.
export { buildOpenApi, buildWellKnownX402, buildX402DnsTxt, GENERATOR } from './discovery.js'
export type {
  PaymentRail,
  ResourceDescription,
  ManifestInput,
  OpenApiDocument,
  OpenApiOperation,
  WellKnownX402,
  X402DnsRecord,
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
} from './indexes.js'
export type {
  DiscoverySource,
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
