// @piprail/sdk — accept x402 crypto payments on any EVM chain and Solana,
// in a couple of lines. No backend, no database, no fee — payments go
// straight to your wallet, verified locally against your own RPC.
//
//   ACCEPT  → requirePayment / createPaymentGate   (server side)
//   PAY     → PipRailClient                        (agent side)
//
// One parameter picks the chain: 'base' | 'bnb' | … (EVM), 'solana', or 'ton'.
// Non-EVM drivers auto-mount on first use — no setup call. (Solana needs
// `@solana/web3.js @solana/spl-token bs58`; TON needs `@ton/ton @ton/core
// @ton/crypto`.)

/* ----------------------------- pay (agent side) ----------------------------- */

export { PipRailClient } from './client.js'
export type {
  PipRailClientOptions,
  PipRailEvent,
  PipRailQuote,
  PipRailCostQuote,
  WalletInput,
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
export type { AgentTool } from './agent.js'

/* --------------------------- accept (server side) --------------------------- */

export { requirePayment, createPaymentGate, toInvalidBody } from './server.js'
export type {
  RequirePaymentOptions,
  AcceptOption,
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
} from './drivers/types.js'

/* ----------------------------- errors ----------------------------- */

export {
  PipRailError,
  InsufficientFundsError,
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
  buildChallengeHeader,
  buildSignatureHeader,
  buildReceiptHeader,
} from './x402.js'
export type {
  Caip2,
  AssetId,
  AddressId,
  VerifyResult,
  VerifyErrorCode,
  X402AcceptEntry,
  X402Challenge,
  X402PaymentSignature,
  X402Receipt,
  X402ResourceObject,
} from './x402.js'

/* ------------- x402 `exact`-scheme interop (EVM, experimental) ------------- */

// EXPERIMENTAL building blocks to PAY a server speaking the mainstream x402
// `exact` scheme (EIP-3009 + facilitator) — making PipRail a universal x402
// client. Not wired into PipRailClient's default flow; hand-roll with these and
// validate against your target facilitator. See ERRORS.md / the README.
export {
  parseExactRequirements,
  chainIdForExactNetwork,
  buildExactAuthorization,
  encodeXPaymentHeader,
  EXACT_NETWORK_SLUGS,
  EIP3009_TYPES,
} from './drivers/evm/exact.js'
export type { ExactAccept, ExactAuthorization, BuildExactParams } from './drivers/evm/exact.js'
