/**
 * The PaymentDriver contract. Every chain-family section (EVM, Solana, …)
 * implements this and nothing else; the protocol layer (server/client/x402)
 * depends on THIS file only — zero `viem`, zero `@solana/web3.js`.
 *
 * Convention used throughout the driver layer:
 *   `chain`   = the developer-supplied selector ('base', { id, rpcUrl }, …)
 *   `network` = the resolved CAIP-2 id it maps to ('eip155:8453', 'solana:…')
 *
 * Identifiers cross this boundary as plain strings (CAIP-2 networks, base-unit
 * amounts, `0x…`/base58 addresses). `_native` on a WalletHandle is the single
 * intentional `unknown`: each driver stashes its own wallet object there.
 */
import type { Caip2, X402AcceptEntry, VerifyResult } from '../x402.js'
import type { ChainInput } from './evm/chains.js'

/** The chain families the SDK knows about. */
export type ChainFamily =
  | 'evm'
  | 'solana'
  | 'ton'
  | 'stellar'
  | 'xrpl'
  | 'tron'
  | 'sui'
  | 'near'

/** What chain to use: an EVM name/Chain/{id,rpcUrl}, or a non-EVM family name. */
export type ChainSelector =
  | ChainInput
  | 'solana'
  | 'ton'
  | 'stellar'
  | 'xrpl'
  | 'tron'
  | 'sui'
  | 'near'

/** An EVM ERC-20 token, by contract address. */
export interface EvmToken {
  address: `0x${string}`
  decimals: number
  symbol?: string
}

/** A Solana SPL token, by mint. */
export interface SolanaToken {
  mint: string
  decimals: number
  symbol?: string
}

/** A TON jetton, by master address. */
export interface TonToken {
  master: string
  decimals: number
  symbol?: string
}

/** A Stellar classic asset, by issuer + code. */
export interface StellarToken {
  issuer: string
  code: string
  decimals: number
  symbol?: string
}

/** An XRP Ledger issued currency, by issuer + 160-bit currency code (hex). */
export interface XrplToken {
  issuer: string
  /** The currency: a 3-char ASCII code, or the 40-char 160-bit hex for 4+ chars. */
  currencyHex: string
  decimals: number
  symbol?: string
}

/** A Tron TRC-20 token, by contract address (Base58 T…). */
export interface TronToken {
  address: string
  decimals: number
  symbol?: string
}

/** A Sui coin, by its fully-qualified coin type (`package::module::TYPE`). */
export interface SuiToken {
  coinType: string
  decimals: number
  symbol?: string
}

/** A NEAR NEP-141 token, by its contract account id. */
export interface NearToken {
  contractId: string
  decimals: number
  symbol?: string
}

/**
 * What to be paid in. Each driver validates the forms it accepts:
 *   - 'native'        the chain's native coin (ETH, BNB, SOL, TON, XLM, XRP)
 *   - 'USDC' (string) a symbol resolved against the chosen chain
 *   - EvmToken        any ERC-20         (EVM chains)
 *   - SolanaToken     any SPL token      (Solana)
 *   - TonToken        any jetton         (TON)
 *   - StellarToken    any classic asset  (Stellar)
 *   - XrplToken       any issued currency (XRPL)
 *   - TronToken       any TRC-20         (Tron)
 *   - SuiToken        any coin           (Sui)
 *   - NearToken       any NEP-141        (NEAR)
 */
export type TokenInput =
  // eslint-disable-next-line @typescript-eslint/ban-types
  | 'native'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
  | EvmToken
  | SolanaToken
  | TonToken
  | StellarToken
  | XrplToken
  | TronToken
  | SuiToken
  | NearToken

/** What a driver resolves a TokenInput into. `asset`: 0x | base58 mint | 'native'. */
export interface ResolvedToken {
  asset: string
  decimals: number
  symbol?: string
}

/**
 * A best-effort estimate of the on-chain NETWORK FEE (gas) a payment will cost
 * the payer — denominated in the chain's NATIVE coin, which is distinct from the
 * payment token (you pay in USDC but burn ETH / SOL / TRX / … for gas). Lets an
 * agent learn the gas cost BEFORE it pays, so it can keep enough native coin on
 * hand. Built uniformly by the shared `nativeCost()` helper, so every family's
 * shape is identical. Converting to fiat needs the caller's own price source —
 * PipRail stays backendless and never calls an oracle.
 */
export interface CostEstimate {
  /** The native fee coin's ticker — ETH, BNB, SOL, TON, XLM, XRP, TRX, … */
  feeSymbol: string
  /** The native coin's decimals (18 EVM, 9 Solana/TON, 7 Stellar, 6 XRPL/Tron). */
  feeDecimals: number
  /** Estimated fee in the native coin's base units (a non-negative integer string). */
  fee: string
  /** Human-readable fee, e.g. '0.000021'. */
  feeFormatted: string
  /** 'estimated' = derived from a live RPC read; 'heuristic' = a typical-cost constant. */
  basis: 'estimated' | 'heuristic'
  /** Short human note on what's included (e.g. 'gas ~21000 @ 12 gwei'). */
  detail?: string
}

/** Opaque per-driver wallet handle — `_native` holds the driver's own object. */
export interface WalletHandle {
  readonly _native: unknown
}

export interface ConfirmInfo {
  /** Block number (EVM) or slot (Solana) as a string — numeric-agnostic. */
  height: string
}

/**
 * A driver bound to one concrete network — what the gate and client hold. Each
 * method's error behaviour is fixed by the SDK error standard (see ERRORS.md §5):
 * `resolveToken`/`assertValidPayTo`/`bindWallet` throw `WrongFamilyError` /
 * `UnknownTokenError`; `send` maps affordability to `InsufficientFundsError`;
 * `verify` RETURNS a `VerifyResult` (and never throws for an RPC hiccup —
 * transient reads become `tx_not_found`); `confirm` throws `ConfirmationTimeoutError`.
 */
export interface ResolvedNetwork {
  readonly family: ChainFamily
  /** The resolved CAIP-2 id: 'eip155:8453' | 'solana:<genesis>' | … */
  readonly network: Caip2

  /** Does this bound network handle the given CAIP-2 network string? */
  supports(network: string): boolean

  /** Turn a TokenInput into { asset, decimals, symbol } for this network. */
  resolveToken(token: TokenInput): ResolvedToken

  /**
   * Trusted metadata for a resolved on-chain `asset` id on THIS network — the
   * SDK's OWN decimals/symbol for a built-in token or the native coin, or `null`
   * if the SDK doesn't recognise the asset (a custom token it can't safely
   * price). Pure/synchronous — a built-in-map + native lookup, never an RPC call.
   *
   * The client uses it to enforce a spend budget against the token's TRUE
   * decimals (so a server can't understate a price by lying about
   * `extra.decimals`) and to flag when a challenge's stated symbol disagrees
   * with the real one. The inverse of `resolveToken` for known assets.
   */
  describeAsset(asset: string): { symbol?: string; decimals: number } | null

  /** Throw if `payTo` isn't a valid address for this family. */
  assertValidPayTo(payTo: string): void

  /* -------- agent side -------- */
  /** Validate + wrap the user's wallet config for this family. */
  bindWallet(wallet: unknown): WalletHandle
  /** Broadcast payment for `accept`; return the proof ref (tx hash / signature). */
  send(wallet: WalletHandle, accept: X402AcceptEntry): Promise<string>
  /** Wait until `ref` reaches minConfirmations (or finality). */
  confirm(ref: string, minConfirmations: number): Promise<ConfirmInfo>

  /**
   * Best-effort estimate of the network fee (gas) to settle `accept`, in the
   * chain's NATIVE coin (see {@link CostEstimate}). Async (may read RPC) but
   * never throws for a transient RPC issue — it falls back to a 'heuristic'
   * constant. `opts.from` (the payer's address) sharpens chains whose fee
   * depends on the sender (notably Tron energy); omit it for a typical estimate.
   * Payer-side + informational — the gate never calls this.
   */
  estimateCost(
    accept: X402AcceptEntry,
    opts?: { from?: string }
  ): Promise<CostEstimate>

  /* -------- server side -------- */
  /** Verify `ref` satisfies `accept`, RPC-only, in-process. */
  verify(ref: string, accept: X402AcceptEntry): Promise<VerifyResult>
}

export interface ResolveOptions {
  /** The developer-supplied `chain` selector. */
  chain: unknown
  rpcUrl?: string
}

/** A stateless family driver. The registry calls resolve() to bind a network. */
export interface PaymentDriver {
  readonly family: ChainFamily
  /** Recognise + bind the chain input, or return null to let another try. */
  resolve(opts: ResolveOptions): ResolvedNetwork | null
}
