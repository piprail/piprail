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
import type {
  Caip2,
  X402AcceptEntry,
  X402ExactAcceptEntry,
  X402UptoAcceptEntry,
  X402AnyAccept,
  ExactPaymentPayloadAny,
  Permit2UptoPaymentPayload,
  VerifyResult,
  SignedReceipt,
} from '../x402.js'
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
  | 'aptos'
  | 'algorand'

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
  | 'aptos'
  | 'algorand'

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

/** An Aptos Fungible Asset, by its metadata object address. */
export interface AptosToken {
  metadata: string
  decimals: number
  symbol?: string
}

/** An Algorand Standard Asset (ASA), by its numeric asset id. */
export interface AlgorandToken {
  assetId: number
  decimals: number
  symbol?: string
}

/**
 * What to be paid in. Each driver validates the forms it accepts:
 *   - 'native'        the chain's native coin (ETH, BNB, SOL, TON, XLM, XRP, TRX, NEAR, SUI, APT, ALGO)
 *   - 'USDC' (string) a symbol resolved against the chosen chain
 *   - EvmToken        any ERC-20         (EVM chains)
 *   - SolanaToken     any SPL token      (Solana)
 *   - TonToken        any jetton         (TON)
 *   - StellarToken    any classic asset  (Stellar)
 *   - XrplToken       any issued currency (XRPL)
 *   - TronToken       any TRC-20         (Tron)
 *   - SuiToken        any coin           (Sui)
 *   - NearToken       any NEP-141        (NEAR)
 *   - AptosToken      any Fungible Asset (Aptos)
 *   - AlgorandToken   any ASA            (Algorand)
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
  | AptosToken
  | AlgorandToken

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

/**
 * Why a recipient can't receive an asset yet — the chain's one-time receive
 * prerequisite, when it has one. Surfaced by {@link ResolvedNetwork.recipientReady}
 * and relayed by the client's planner so an agent fixes the RECIPIENT (not its own
 * balance). Families with no prerequisite report `ready: 'n/a'` and no reason.
 */
export type RecipientReason =
  | 'NO_TRUSTLINE' // Stellar / XRPL: the account holds no trustline for this asset
  | 'NOT_REGISTERED' // NEAR: payTo isn't storage_deposit-registered on the NEP-141 token
  | 'NOT_OPTED_IN' // Algorand: payTo hasn't opted into the ASA
  | 'INACTIVE' // Stellar / XRPL: the account doesn't exist / isn't reserve-funded yet

/** What {@link ResolvedNetwork.balanceOf} returns — base-unit balances, or null per
 *  field when that read was unavailable (transient/RPC), never a false 0. */
export interface WalletBalance {
  /** The payment token's balance in base units, or null if the read was unavailable. */
  token: bigint | null
  /** The native gas coin's balance in base units, or null if unavailable. For
   *  `asset === 'native'`, this equals `token`. */
  native: bigint | null
}

export interface ConfirmInfo {
  /** Block number (EVM) or slot (Solana) as a string — numeric-agnostic. */
  height: string
}

/**
 * A discovery signer — the bound wallet's address + a message signer. Returned
 * by {@link ResolvedNetwork.discoverySigner} and used ONLY for discovery
 * (ownership proofs / SIWX registration), never to move funds. Structurally what
 * the open-index register helpers consume.
 */
export interface DiscoverySigner {
  /** The wallet's own public address (EVM 0x…), declared in a SIWX challenge. */
  address: string
  /** Sign an arbitrary UTF-8 message (EVM: eip191) — for proofs/SIWX only. */
  signMessage(message: string): Promise<string>
}

/**
 * The official x402 `offer-receipt` §5.2 signed-field set a merchant attests over in
 * Tier-2 — the SMALLER official payload (NOT PipRail's full {@link X402Receipt}),
 * consumed by the optional EVM-only {@link ResolvedNetwork.signReceipt}. The gate
 * maps PipRail's settlement data into it. `payTo` rides ALONGSIDE the signed fields
 * purely so a verifier knows the expected signer (`recover === payTo`); it is NOT
 * part of the EIP-712 message.
 */
export interface ReceiptInput {
  /** The merchant `payTo` wallet — the signer a verifier checks `recover ===` against. NOT signed. */
  payTo: string
  /** CAIP-2 network the settlement happened on (signed `network`). */
  network: string
  /** The paid resource URL (signed `resourceUrl`). */
  resourceUrl: string
  /** The payer identifier — the on-chain sender (signed `payer`). */
  payer: string
  /** Unix SECONDS the receipt was issued (signed `issuedAt`). */
  issuedAt: number
  /**
   * The settlement tx hash, or the empty string `''` when suppressed
   * (`includeTxHash:false`). §5.3: the signed EIP-712 message MUST carry `''`,
   * NEVER an omitted key — a verifier treats `''` as absence. Default `''`.
   */
  transaction?: string
}

/**
 * How a family advertises a standard `exact` rail for one asset — returned by
 * {@link ResolvedNetwork.resolveExactRail} and consumed by the gate to build the
 * `X402ExactAcceptEntry`. The `method` is the family's transfer method (EVM:
 * `'eip3009'`/`'permit2'`, Solana: `'svm'`); `extra` is merged VERBATIM into the
 * accept's `extra`, carrying the family-specific bits a payer needs (EVM: the EIP-712
 * `name`/`version`; Solana: the merchant `feePayer` + `tokenProgram`). Keeping the
 * chain-specific shape behind this descriptor is what lets `server.ts` stay
 * chain-agnostic — it never names a family, it just merges `extra`.
 */
export interface ExactRailInfo {
  /** The wire `assetTransferMethod` this family advertises. XRPL's `'sequence'` is the odd one
   *  out: it names how the transaction is SEQUENCED rather than a transfer mechanism, because the
   *  ledger has only one way to move value. */
  method: 'eip3009' | 'permit2' | 'svm' | 'algorand' | 'aptos' | 'near' | 'sequence'
  /** Family-specific `extra` keys merged into the exact accept (e.g. `{ name, version }`
   *  for EVM EIP-3009, `{ feePayer, tokenProgram }` for Solana, `{ feePayer }` for
   *  Algorand/Aptos/NEAR). */
  extra?: Record<string, unknown>
}

/**
 * How a family advertises a standard `upto` (metered) rail for one asset — the metered
 * sibling of {@link ExactRailInfo}, returned by {@link ResolvedNetwork.resolveUptoRail}
 * and consumed by the gate to build the `X402UptoAcceptEntry`. The `method` is always the
 * PipRail-internal `'permit2-upto'` (upto is EVM-Permit2 only); `extra` is merged VERBATIM
 * into the accept's `extra`, carrying `{ facilitatorAddress, name?, version? }` — the
 * relayer address the buyer signs into `witness.facilitator` plus the token's EIP-712
 * domain bits. Keeping the chain-specific shape behind this descriptor is what lets
 * `server.ts` stay chain-agnostic — it never names a family, it just merges `extra`.
 */
export interface UptoRailInfo {
  method: 'permit2-upto'
  /** Family-specific `extra` keys merged into the upto accept: `{ facilitatorAddress, name?, version? }`. */
  extra?: Record<string, unknown>
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
   * Payer-side + informational — the gate never calls this. Accepts either rail
   * shape ({@link X402AnyAccept}): a standard `exact` rail estimates the BUYER's gas
   * as ~0 (the server/facilitator broadcasts the signed authorization).
   */
  estimateCost(
    accept: X402AnyAccept,
    opts?: { from?: string }
  ): Promise<CostEstimate>

  /**
   * Read the BOUND WALLET's own balance of the payment `asset` AND of the native
   * gas coin, in base units — what the client's `planPayment` checks affordability
   * against. RPC-read-only and NEVER throws: a field whose read was unavailable
   * (rate-limited / transient) comes back `null` (unknown), never `0` (which would
   * falsely read "broke"). For `asset === 'native'`, `token === native`.
   * Payer-side + informational — the gate never calls this. See {@link WalletBalance}.
   */
  balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance>

  /**
   * Can `payTo` RECEIVE `asset` on this network right now? Reports the chain's
   * one-time receive prerequisite (trustline / storage_deposit / ASA opt-in /
   * activation):
   *   - `{ ready: 'n/a' }`         the family has NO prerequisite (EVM, Solana, TON,
   *                                Tron, Sui, Aptos — and every native coin)
   *   - `{ ready: true }`          the prerequisite is satisfied
   *   - `{ ready: false, reason }` it's missing (see {@link RecipientReason}) — fix the recipient
   *   - `{ ready: 'unknown' }`     the probe read failed (transient) — NEVER throws
   * Re-derives nothing from a client ref; reads only the given `payTo`. Payer-side
   * pre-flight — the gate never calls this.
   */
  recipientReady(
    payTo: string,
    asset: string
  ): Promise<{ ready: boolean | 'n/a' | 'unknown'; reason?: RecipientReason }>

  /**
   * OPTIONAL (EVM EIP-3009/Permit2 + Solana SVM + Algorand + Aptos) — the BUYER counterpart to {@link settleExactSelf}.
   * Build + EIP-712-sign an EIP-3009 `transferWithAuthorization` for a standard x402
   * `exact` rail, so a PipRail agent can PAY any standard x402 server (not just PipRail's
   * own `onchain-proof` gates). The client frames the returned `payload` + `accepted` echo
   * into the `PAYMENT-SIGNATURE` header and re-requests; the server / merchant-chosen
   * facilitator BROADCASTS the authorization (the buyer never broadcasts and spends ~0 gas).
   *
   * Re-derives the token's EIP-712 domain ON-CHAIN (never trusts the server-supplied
   * `extra.{name,version}`), generates a CSPRNG 32-byte nonce + current unix time
   * internally, and signs through the wallet client (bring-your-own JsonRpcAccount safe).
   * THROWS a typed `PipRailError` (`UnsupportedSchemeError`) when the asset isn't EIP-3009
   * (USDT/native/plain ERC-20) or the signer is a contract / EIP-1271 / EIP-7702 account.
   *
   * The third optional `exact` method (after {@link exactDomain}/{@link settleExactSelf});
   * optional `?` is the gather gate — non-EVM families omit it, so an `exact` rail is never
   * gathered/paid on those chains. Returns the signed payload, the chosen-rail echo (the
   * server's RAW rail, verbatim, so a facilitator's extra keys survive), the payer address,
   * and the nonce (for the client's spend record + a re-present-the-same-auth retry).
   */
  payExact?(
    wallet: WalletHandle,
    accept: X402ExactAcceptEntry
  ): Promise<{
    payload: ExactPaymentPayloadAny
    accepted: X402ExactAcceptEntry
    payerFrom: string
    nonce: string
  }>

  /**
   * OPTIONAL — a DISCOVERY signer for the bound wallet: its public address plus a
   * message signer, used only for ownership proofs + SIWX index registration,
   * NEVER the payment path. `signMessage` returns a chain-native signature string
   * (EVM: 0x eip191 hex, recoverable with `recoverMessageAddress` — exactly how
   * x402scan verifies origin ownership). Deliberately optional: a family ships it
   * only once an open index verifies its signatures — EVM today (the 402 Index
   * register path needs no signature at all). The client's `register()` skips
   * signature-gated steps for a family that omits it. The first optional contract
   * method, so it does NOT trigger the "implement in all families" rule for
   * REQUIRED methods. Returns `null` if the bound wallet can't sign.
   */
  discoverySigner?(wallet: WalletHandle): DiscoverySigner | null

  /**
   * OPTIONAL (EVM-only today) — Tier-2 service-delivery attestation. Sign the
   * official x402 `offer-receipt` EIP-712 `RECEIPT_TYPES` (the SMALLER official
   * §5.2 payload) with the bound wallet — typically the merchant's existing `payTo`
   * key — so a buyer can prove the resource was SERVED, the one thing the chain
   * can't attest. A verifier ({@link PipRailClient.verifyAttestation}) re-recovers
   * and checks `recover === payTo`. The signed domain is hardcoded `chainId:1` for
   * EVERY network (uniform signing), so this is chain-independent and EVM-only by
   * the optional `?` gate — non-EVM families omit it (no all-families mirror),
   * exactly like {@link discoverySigner}/{@link payExact}. The gate calls it after
   * settle when `receipts.attest` is set + the rail is EVM; the result rides in
   * `extensions['offer-receipt'].info.attestation`. NEVER part of the payment path.
   */
  signReceipt?(wallet: WalletHandle, input: ReceiptInput): Promise<SignedReceipt>

  /* -------- server side -------- */
  /** Verify `ref` satisfies `accept`, RPC-only, in-process. */
  verify(ref: string, accept: X402AcceptEntry): Promise<VerifyResult>

  /**
   * OPTIONAL — resolve a standard `exact` rail for `asset` on this network, or `null`
   * when this asset/chain can't carry one (a native coin, an unsupported token, or a
   * family with no `exact` settlement). This is the gate's rail-ADVERTISEMENT SPI: the
   * chain-agnostic `server.ts` calls it to decide whether to dual-advertise an `exact`
   * rail beside `onchain-proof`, and uses the returned {@link ExactRailInfo} to build the
   * `X402ExactAcceptEntry` — so the gate never special-cases a family.
   *
   * `method` is the merchant's preference (`'auto'` lets the family pick — EVM auto-selects
   * EIP-3009 over Permit2; Solana ignores it and always uses `'svm'`). The fee payer for a
   * family that needs one (Solana) comes from EITHER `feePayer` (a facilitator-provided
   * sponsor pubkey, in facilitator mode — so neither buyer nor merchant pays gas) OR `relayer`
   * (the merchant's own bound self-settle wallet, in self mode); `feePayer` takes precedence.
   * RPC-read (EVM reads the token's EIP-712 domain; Solana reads the mint's token program); MAY
   * throw a typed config error for an explicitly-requested-but-unsupported method (EVM does). A
   * family that omits this method offers no `exact` rail (today: every family except EVM, Solana, Algorand, and Aptos).
   */
  resolveExactRail?(input: {
    asset: string
    method: 'eip3009' | 'permit2' | 'svm' | 'auto'
    relayer?: WalletHandle
    /** A facilitator-provided fee-payer pubkey (facilitator mode); overrides the relayer's. */
    feePayer?: string
  }): Promise<ExactRailInfo | null>

  /**
   * OPTIONAL (EVM-only today) — the on-chain EIP-712 domain `{ name, version }` of an
   * EIP-3009 token `asset`, read from the contract (`name()`/`version()`). Returns
   * `null` when the asset is NOT an EIP-3009 token (no `transferWithAuthorization` —
   * e.g. USDT, native coin, or a plain ERC-20), so the gate can refuse to advertise a
   * standard `exact` rail for it. Never derived from the symbol (USDC's domain name is
   * "USD Coin", not "USDC"; EURC's is "Euro Coin" on Ethereum/Avalanche but "EURC" on Base —
   * which is exactly why it must be READ, never assumed). Called once at exact-rail resolution
   * (cached by the gate). RPC-read; may throw on a transient read (the gate surfaces a
   * clear config error). The first of two optional server methods for the `exact` rail.
   */
  exactDomain?(asset: string): Promise<{ name: string; version: string } | null>

  /**
   * OPTIONAL (EVM-only) — whether this chain can carry the **Permit2** transfer method
   * of the `exact` scheme: i.e. the canonical Permit2 **and** the `x402ExactPermit2Proxy`
   * are deployed here. The gate calls it to AVOID advertising a Permit2 `exact` rail it
   * could never settle (a non-EIP-3009 token on a proxy-less chain — e.g. Binance-Peg
   * USDC on a chain without the proxy). EIP-3009 needs no proxy, so this gates ONLY the
   * Permit2 fallback. Omitted (or `false`) ⇒ treat Permit2 as unavailable on this chain.
   */
  exactPermit2Supported?(): boolean

  /**
   * OPTIONAL — can this family sign an `exact` payment for THIS asset? Omitted ⇒ the default rule
   * applies: any recognised TOKEN yes, the NATIVE coin no (`exact` is a signed-authorization scheme
   * a native coin can't carry on EVM/Solana/Algorand/Aptos/NEAR). A driver that declares this hook
   * REPLACES that rule for itself and is authoritative for all of its assets.
   *
   * The buyer's gather calls it so an asset we cannot price safely is dropped *there* rather than
   * planned `payable` and thrown at signing — the plan-vs-pay contract. Family-level capability is
   * already covered by whether `payExact` exists at all; this is the per-ASSET refinement.
   *
   * XRPL is why it exists, and it inverts the default in both directions: native XRP IS
   * exact-payable (863 of its 1,732 live rails are priced in XRP, and an `exact` payment there is
   * just a signed `Payment`), while its issued currencies are NOT. On that ledger the two asset
   * forms use DIFFERENT amount conventions on the wire — native XRP is an integer drops string (base units, e.g. `"10000"`), while an issued
   * currency is a decimal `value` (e.g. `"0.01"`), both verified against live merchant challenges.
   * The SDK prices and spend-caps every rail in base units, so reading an IOU's `"12"` as base
   * units would understate a 12-RLUSD payment by 10^15 and let it slip under any policy cap while
   * the buyer signed the real thing. Until that decimal path is threaded through quoting and the
   * policy, XRPL declares only native XRP exact-payable.
   */
  exactPayableAsset?(asset: string): boolean

  /**
   * OPTIONAL (EVM EIP-3009/Permit2 + Solana SVM + Algorand + Aptos) — verify a standard x402 `exact`
   * payment locally, then SELF-SETTLE it by broadcasting from the merchant's own `relayer`
   * wallet (the merchant pays the network fee to receive; EVM broadcasts
   * `transferWithAuthorization`, Solana co-signs the fee payer, Algorand signs the pooled fee
   * txn + submits the group, Aptos adds the fee-payer signature + submits — the transfer
   * binds `payTo`, so no redirect risk). RETURNS a `VerifyResult`:
   *   - `{ ok:false, error }` for a CLIENT-fixable fault (bad signature, expired,
   *     wrong recipient/amount, used nonce, simulation revert) → gate replies 402;
   *   - `{ ok:true, receipt }` once the settle tx is mined.
   * THROWS {@link SettlementError} when a VALID + simulated payment fails to BROADCAST
   * (relayer out of gas / RPC down) → gate replies 5xx (the payer's authorization is
   * still good and its nonce unused). Re-derives every checked field from the trusted
   * `accept`, never the client echo.
   */
  settleExactSelf?(input: {
    relayer: WalletHandle
    payload: ExactPaymentPayloadAny
    accept: X402ExactAcceptEntry
  }): Promise<VerifyResult>

  /**
   * OPTIONAL (EVM-Permit2 ONLY) — advertise a standard `upto` (metered) rail for `asset`,
   * or `null` when this asset/chain can't carry one (a native coin, a non-Permit2-proxy
   * chain, a non-Permit2 token). The gate's rail-advertisement SPI for the metered rail —
   * the parallel of {@link resolveExactRail}. The `relayer` becomes the bound
   * `witness.facilitator` (upto is self-settle only in v1, no facilitator mode), so the
   * returned `extra.facilitatorAddress` is the relayer's own address. The optional `?` IS
   * the EVM-only gate — every non-EVM family omits it, so the gate never offers upto there.
   * RPC-read (EVM reads the token's EIP-712 domain); never throws for a transient read.
   */
  resolveUptoRail?(input: { asset: string; relayer: WalletHandle }): Promise<UptoRailInfo | null>

  /**
   * OPTIONAL (EVM-Permit2 ONLY) — BUYER side: sign a Permit2 `PermitWitnessTransferFrom`
   * authorization for the MAX (`accept.amount`), binding `witness.facilitator =
   * accept.extra.facilitatorAddress` as the MIDDLE witness field. Re-derives the proxy +
   * witness types internally; never trusts a server-supplied domain. The metered counterpart
   * to {@link payExact}. The client frames the returned `payload` + `accepted` echo into the
   * `PAYMENT-SIGNATURE` header; the merchant self-settles the actual. Returns the signed
   * payload, the chosen-rail echo, the payer address, and the Permit2 nonce. THROWS a typed
   * `PipRailError` when the signer is a contract / EIP-1271 / EIP-7702 account.
   */
  payUpto?(
    wallet: WalletHandle,
    accept: X402UptoAcceptEntry
  ): Promise<{
    payload: Permit2UptoPaymentPayload
    accepted: X402UptoAcceptEntry
    payerFrom: string
    nonce: string
  }>

  /**
   * OPTIONAL (EVM-Permit2 ONLY) — SELLER side: verify a standard x402 `upto` payment
   * locally, then SELF-SETTLE the ACTUAL (`settleAmount`, ≤ the signed max) through the upto
   * proxy from the merchant's `relayer`. The metered counterpart to {@link settleExactSelf}.
   * Re-verifies the signature against `permitted.amount` (the signed MAX, NEVER the metered
   * actual — verifying against the actual would reject every partial settle); guards
   * `witness.facilitator === relayer.address`; clamps/rejects `settleAmount > max` with
   * `upto_settle_exceeds_max`; SKIPS the on-chain tx when `settleAmount === 0n` (a synthetic
   * zero-charge receipt with `transaction: ""`). RETURNS a `VerifyResult` for a client-fixable
   * fault; THROWS {@link SettlementError} on a broadcast failure of a valid auth. Re-derives
   * every checked field from the trusted `accept`, never the client echo.
   */
  settleUptoSelf?(input: {
    relayer: WalletHandle
    payload: Permit2UptoPaymentPayload
    accept: X402UptoAcceptEntry
    settleAmount: bigint
  }): Promise<VerifyResult>
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
