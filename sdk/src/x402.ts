/**
 * The on-the-wire payment protocol. Self-contained — it runs entirely
 * between the agent and your server, with nothing hosted in between.
 *
 * Lowercase headers, no `X-` prefix:
 *   - payment-required   (server → client, base64 JSON challenge)
 *   - payment-signature  (client → server, base64 JSON proof)
 *   - payment-response   (server → client, base64 JSON receipt on 200)
 *
 * Scheme is `onchain-proof`: the agent pays on-chain and hands back a proof
 * reference (an EVM tx hash, a Solana signature, …); the server verifies
 * that transaction itself, locally, against its own RPC. No third party.
 *
 * This file is CHAIN-AGNOSTIC. Identifiers are plain strings in CAIP-2 /
 * base-unit form so any family (EVM, Solana, …) round-trips through the same
 * envelopes. Each PaymentDriver interprets them for its own chain.
 *
 * Wire format targets x402 v2 — github.com/coinbase/x402, specs/x402-specification-v2.md
 * (v2.0, 2025-12-9) + specs/transports-v2/http.md. The ENVELOPE is v2-conformant
 * (PaymentPayload carries `accepted`; SettlementResponse has `success` + `transaction`).
 * The SETTLEMENT SCHEME is our own `onchain-proof` (client pays on-chain first, proves
 * with a tx ref, server verifies locally) — permitted by spec §6 (a scheme owns its
 * `payload`) + §7 (self-hosted verification), but it does NOT interoperate with the
 * built-in `exact` scheme (which is signature + facilitator-broadcast). Deliberate.
 */

// The one import this module has. `errors.ts` imports nothing at all, so there is no cycle,
// and a typed error is required by ERRORS.md section 1 for anything a caller can trigger —
// which includes handing a BigInt to a header builder.
import { InvalidConfigError } from './errors.js'
// Slug → CAIP-2 canonicalisation, used by the v1 challenge normalizer. `indexes.ts` owns the
// table (it is the discovery surface that first needed it) and imports only TYPES from here,
// so this value import adds no runtime cycle. Protocol → protocol: still no chain library.
import { normalizeNetwork } from './indexes.js'

/** A CAIP-2 network id, e.g. `eip155:8453` or `solana:5eykt4Us…`. */
export type Caip2 = `${string}:${string}`
/** An asset id — chain-specific: an EVM `0x…` address, a Solana base58 mint, a
 * TON jetton master, a Stellar `CODE:ISSUER`, or `'native'`. */
export type AssetId = string
/** An account id — chain-specific: an EVM `0x…` address, a Solana base58 pubkey,
 * a TON address, or a Stellar `G…` account. */
export type AddressId = string

export interface X402ResourceObject {
  url: string
  description?: string
  /** The resource's response content-type, e.g. 'application/json' (v2 ResourceInfo, optional). */
  mimeType?: string
}

export interface X402AcceptEntry {
  scheme: 'onchain-proof'
  network: Caip2
  /** Amount in the token's base units (already scaled by decimals). */
  amount: string
  /** ERC-20 address / SPL mint, or 'native' for the chain's native coin. */
  asset: AssetId
  payTo: AddressId
  /** Payment is only accepted if mined within this many seconds of now. */
  maxTimeoutSeconds: number
  extra: {
    /** Single-use id echoed back in the proof. */
    nonce: string
    /** Token decimals, so the client can render the amount. */
    decimals: number
    /** Confirmations the client should wait before retrying. */
    minConfirmations: number
    /** Human-readable amount, e.g. "0.05". */
    amountFormatted: string
    symbol?: string
  }
}

/**
 * A standard x402 `exact` rail (EVM / EIP-3009) — the interop rail a PipRail gate
 * advertises ALONGSIDE its `onchain-proof` rail (dual-advertise) so any standard
 * x402 client can pay it. Same v2 PaymentRequirements skeleton as
 * {@link X402AcceptEntry}; only `scheme` and `extra` differ. The `extra` carries
 * the EIP-712 domain a payer signs over — `name`/`version` are READ from the token
 * contract by the gate (never assumed), since e.g. USDC's domain name is "USD Coin",
 * not the "USDC" symbol.
 */
export interface X402ExactAcceptEntry {
  scheme: 'exact'
  network: Caip2
  amount: string
  asset: AssetId
  payTo: AddressId
  maxTimeoutSeconds: number
  /**
   * The network id EXACTLY as an x402 **v1** server wrote it (a slug like `'base'`),
   * preserved by {@link normalizeV1Challenge} because `network` above is canonicalised to
   * CAIP-2 for matching while a v1 server string-compares the slug it sent. Internal to the
   * v1 compat path — absent on every v2 rail, and STRIPPED from every outgoing `accepted`
   * echo by `withoutWireNetwork`, since the merchant never published this key.
   */
  wireNetwork?: string
  /**
   * Scheme-defined extras. **OPTIONAL when PARSING a foreign 402** — the exact-EVM scheme
   * makes every `extra` key optional (`assetTransferMethod` defaults to `'eip3009'`), and the
   * SVM/Algorand/Aptos/NEAR/Hedera schemes define no `assetTransferMethod` at all, so a
   * conformant rail may ship `extra: {}` or omit the block entirely. A PipRail **gate** always
   * emits it. Every read on the buyer path must optional-chain.
   */
  extra?: {
    /** The exact transfer method. **OPTIONAL** — `scheme_exact_evm.md`: *"If no
     *  `assetTransferMethod` is specified in `PaymentRequired.extra`, clients should default
     *  to `\"eip3009\"`"* (and only the non-default methods make it required). The SVM,
     *  Algorand, Aptos, NEAR and Hedera schemes never define this key. Read it through
     *  {@link exactTransferMethod}, never bare — 91% of the deployed x402 web omits it.
     *  EVM: `'eip3009'` for tokens with native
     *  `transferWithAuthorization`, or `'permit2'` for tokens WITHOUT it (e.g.
     *  Binance-Peg USDC on BNB) — the payer signs a Permit2 witness transfer whose
     *  `spender` is the canonical x402ExactPermit2Proxy and whose `witness.to` binds the
     *  recipient. **Solana (SVM): `'svm'`** — the payer partial-signs an SPL
     *  `TransferChecked` transaction whose fee payer is the merchant (`feePayer` below),
     *  and the gate co-signs as fee payer + broadcasts. **Algorand: `'algorand'`** — the payer
     *  signs an ASA `axfer` to `payTo` at fee 0, atomically grouped with a 0-ALGO `pay` from
     *  the `feePayer` that pools the group fee (per `scheme_exact_algo.md`); the gate (or a
     *  keyless facilitator) signs that fee txn + submits. **Aptos: `'aptos'`** — the payer signs a
     *  fee-payer (sponsored) `primary_fungible_store::transfer` to `payTo` (per
     *  `scheme_exact_aptos.md`); the gate (or a keyless facilitator) adds the fee-payer signature
     *  + submits, paying gas. **NEAR: `'near'`** — the payer signs a NEP-366 `SignedDelegateAction`
     *  authorizing exactly one NEP-141 `ft_transfer` to `payTo` (per `scheme_exact_near.md`); a
     *  facilitator-selected relayer (`feePayer` below) prepays gas + the 1 yoctoNEAR and submits, so
     *  the buyer holds zero NEAR. PipRail self-settles ALL. */
    assetTransferMethod?:
      | 'eip3009'
      | 'permit2'
      /** A FOREIGN-dialect alias for `'permit2'` — Binance's x402 ("b402") facilitator labels its
       *  EVM-Permit2 exact rail `'permit2-exact'` (the coinbase/x402 spec uses bare `'permit2'`).
       *  PipRail EMITS only `'permit2'`; it TOLERATES `'permit2-exact'` inbound so the buyer pays a
       *  Binance-issued 402 (the buyer treats the two as one rail). NB: settlement still requires the
       *  rail to bind PipRail's canonical x402ExactPermit2Proxy — see the buyer in drivers/evm. */
      | 'permit2-exact'
      | 'svm'
      | 'algorand'
      | 'aptos'
      | 'near'
    /** EIP-712 domain name of the token. OPTIONAL per the exact-EVM scheme (only
     *  `assetTransferMethod` is required) — a foreign rail may omit it. NEVER assumed
     *  from the symbol (USDC's on-chain name() is "USD Coin", not "USDC"); a PipRail gate
     *  READS it on-chain, and the PipRail buyer RE-DERIVES it on-chain and ignores this. */
    name?: string
    /** EIP-712 domain version of the token (USDC: "2"). OPTIONAL (see `name`); read/re-derived on-chain. */
    version?: string
    /** **SVM / Algorand / Aptos** — the fee-payer (gas sponsor) address. The buyer builds the
     *  transaction with this account as the gas payer (so the buyer spends ZERO native coin),
     *  leaving its signature for whoever sponsors; the gate (self mode) or a keyless facilitator
     *  fills it and submits. On **SVM** it must differ from `payTo` (the fee payer must never
     *  appear in an instruction — a MUST-rule); on **Algorand/Aptos** the fee txn/signature is
     *  separate from the transfer, so `feePayer === payTo` is allowed. */
    feePayer?: string
    /** **SVM only, OPTIONAL** — a ≤256-byte reconciliation memo the buyer attaches to the
     *  transaction (the SVM scheme's optional `extra.memo`). */
    memo?: string
    /** **SVM only** — which SPL token program the mint belongs to, so both the buyer and
     *  the gate derive the SAME associated-token-account address (an ATA's address depends
     *  on the token program). Defaults to `'spl-token'` (classic) when absent — the
     *  built-in USDC/USDT are classic. */
    tokenProgram?: 'spl-token' | 'token-2022'
    /** Confirmations the gate waits for before granting access — mirrors the gate's
     *  `minConfirmations`, so the exact rail honours the same reorg safety as onchain-proof.
     *  A PipRail convenience (standard clients ignore unknown keys). */
    minConfirmations?: number
    /** Token decimals — a PipRail convenience (standard clients ignore unknown keys). */
    decimals?: number
    /** Human-readable amount, e.g. "0.05" — a PipRail convenience. */
    amountFormatted?: string
    symbol?: string
  }
}

/**
 * The transfer method an `exact` rail uses when it names none.
 *
 * `scheme_exact_evm.md` §0: *"If no `assetTransferMethod` is specified in
 * `PaymentRequired.extra`, clients should default to `"eip3009"`."* §1 restates it per-method:
 * `eip3009` is *"optional in `PaymentRequired`, default"*, while `permit2` and `erc7710` are
 * *"required"*. So an absent marker is not a malformed rail — it is the common case (91% of the
 * deployed web) and it means EIP-3009.
 */
export const DEFAULT_EXACT_TRANSFER_METHOD = 'eip3009' as const

/**
 * Every `assetTransferMethod` a PipRail buyer can actually sign, across all families.
 *
 * Used to SKIP a rail that names a method we don't implement (the spec's `erc7710`, or any
 * future one) rather than sign an EIP-3009 authorization a facilitator built for a different
 * mechanism and will reject. An **absent** marker is not "unknown" — see
 * {@link DEFAULT_EXACT_TRANSFER_METHOD}. Family routing stays in each driver's `payExact`;
 * this set only answers "could any driver of ours settle this?".
 */
export const KNOWN_EXACT_TRANSFER_METHODS: ReadonlySet<string> = new Set([
  'eip3009',
  'permit2',
  'permit2-exact', // Binance b402's foreign-dialect alias for `permit2`
  'svm',
  'algorand',
  'aptos',
  'near',
])

/**
 * What each family's driver signs when a rail names no method. Only the EVM scheme defines a
 * written default (`eip3009`); the others define no `assetTransferMethod` at all because each has
 * exactly ONE mechanism, so the family itself is the answer. Used for REPORTING (`PayOption.method`)
 * — routing is the driver's own job. Keyed by `ResolvedNetwork.family`.
 */
const DEFAULT_METHOD_BY_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  evm: 'eip3009',
  solana: 'svm',
  algorand: 'algorand',
  aptos: 'aptos',
  near: 'near',
})

/**
 * The effective transfer method of an `exact` rail: what it names, or the default when it names
 * nothing. THE ONLY sanctioned way to read `extra.assetTransferMethod` — reading it bare is how
 * the buyer came to reject 91% of the x402 web.
 *
 * Pass `family` to get the right default off-EVM: a Solana rail that names nothing means `svm`,
 * not `eip3009`. Without it the EVM default is assumed (correct for the settleability check,
 * since every family's own literal is in {@link KNOWN_EXACT_TRANSFER_METHODS} anyway).
 */
export function exactTransferMethod(accept: X402ExactAcceptEntry, family?: string): string {
  return (
    accept.extra?.assetTransferMethod ??
    (family ? (DEFAULT_METHOD_BY_FAMILY[family] ?? DEFAULT_EXACT_TRANSFER_METHOD) : DEFAULT_EXACT_TRANSFER_METHOD)
  )
}

/**
 * Can any PipRail driver settle this rail's transfer method? True when the rail names a
 * method we implement, AND when it names none (the spec default `eip3009`). False only for a
 * method we don't implement — the rail is then skipped at gather rather than mis-signed.
 */
export function isSettleableExactMethod(accept: X402ExactAcceptEntry): boolean {
  return KNOWN_EXACT_TRANSFER_METHODS.has(exactTransferMethod(accept))
}

/**
 * A standard x402 `upto` rail (EVM / Permit2) — variable-amount / metered billing.
 * The buyer signs a Permit2 `PermitWitnessTransferFrom` authorization for `amount`
 * as a **MAXIMUM**; the merchant serves the resource, meters the **actual** usage, then
 * self-settles `actual ≤ max` through the canonical `x402UptoPermit2Proxy` from its own
 * relayer (which is the bound `witness.facilitator`). EVM-Permit2 ONLY — the upto spec
 * bans EIP-3009 (it fixes the amount at sign time) and has no non-EVM variant. A SEPARATE
 * accept type from {@link X402ExactAcceptEntry}: the only wire delta vs the exact Permit2
 * rail is `scheme: 'upto'` and the `witness.facilitator` field, but keeping them distinct
 * leaves the exact parser/union untouched and lets the gate/client route on `scheme`.
 */
export interface X402UptoAcceptEntry {
  scheme: 'upto'
  network: Caip2
  /** The authorized MAXIMUM in base units (already scaled by decimals). The merchant
   *  settles the ACTUAL (≤ this) after serving. */
  amount: string
  asset: AssetId
  payTo: AddressId
  maxTimeoutSeconds: number
  extra: {
    /** PipRail's transfer-method tag for the upto rail. This literal `'permit2-upto'` IS what
     *  rides on the wire in `extra.assetTransferMethod` — it's a NON-STANDARD extra key (the
     *  upto spec defines no `assetTransferMethod`; the discriminant a conformant foreign client
     *  keys off is `scheme: 'upto'` + the Permit2 witness shape, and it ignores this unknown key).
     *  We carry it so OUR parser stays unambiguous from the exact Permit2 rail. */
    assetTransferMethod: 'permit2-upto'
    /** The address bound into `witness.facilitator`. In self-settle this is the merchant's
     *  own relayer; the buyer MUST sign over it; only this address can settle (the proxy
     *  reverts `UnauthorizedFacilitator()` otherwise). */
    facilitatorAddress: string
    /** The Permit2 domain is fixed (`"Permit2"`), but the token's `name`/`version` ride
     *  along for the optional EIP-2612 gas-sponsoring extension. Read/re-derived on-chain,
     *  never assumed. */
    name?: string
    version?: string
    /** Confirmations the gate waits for before granting access — a PipRail convenience. */
    minConfirmations?: number
    /** Token decimals — a PipRail convenience (standard clients ignore unknown keys). */
    decimals?: number
    /** Human-readable MAX, e.g. "0.50". */
    amountFormatted?: string
    symbol?: string
  }
}

/** A challenge `accepts[]` entry — PipRail's `onchain-proof` rail, a standard `exact`
 *  rail, or a standard `upto` (metered) rail. */
export type X402AnyAccept = X402AcceptEntry | X402ExactAcceptEntry | X402UptoAcceptEntry

export interface X402Challenge {
  /**
   * `2` for every challenge PipRail EMITS. `1` appears only on the PARSE side, when
   * {@link normalizeV1Challenge} has lifted a still-deployed v1 server's body into this
   * shape — the buyer must then answer on the v1 wire (`X-PAYMENT`, flat payload). See the
   * version-posture note above {@link HEADER_SIGNATURE_V1}.
   */
  x402Version: 1 | 2
  /**
   * Optional human-readable reason (v2 `error?: string`). PipRail EMITS it only on a
   * rejected-proof re-challenge (omitted on a fresh challenge). Typed to also tolerate
   * `null` when PARSING a foreign challenge — some deployed servers send `error: null`.
   */
  error?: string | null
  resource: X402ResourceObject
  accepts: X402AnyAccept[]
  /** v2 optional extensions. PipRail stamps the machine-readable rejection reason here on a
   *  rejected-proof re-challenge: `{ piprail: { code, detail } }`. Omitted otherwise. */
  extensions?: Record<string, unknown>
}

export interface X402PaymentSignature {
  x402Version: 2
  /**
   * x402 v2 PaymentPayload: the full PaymentRequirements entry the client chose
   * (carries `scheme` + `network`), echoed back from the challenge's `accepts[]`.
   */
  accepted: X402AcceptEntry
  /**
   * Scheme-defined payload. For `onchain-proof`: the challenge nonce + the proof
   * ref (`txHash` — a chain-specific id: an EVM tx hash, a Solana signature, a
   * TON locator, or a Stellar tx hash).
   */
  payload: { nonce: string; txHash: string }
  /**
   * Optional v2 extensions the client attaches to its payload — e.g. the
   * `payment-identifier` idempotency id at `extensions['payment-identifier'].info.id`
   * (read by the gate via {@link readPaymentIdentifier}). A standard reader ignores it,
   * and omitting it keeps the payload byte-identical.
   */
  extensions?: Record<string, unknown>
}

/**
 * The EIP-3009 authorization a payer signs for a standard `exact` rail. All
 * numeric fields are DECIMAL strings on the wire (value, validAfter, validBefore);
 * `nonce` is a 0x-prefixed 32-byte hex. Identical shape across x402 v1 and v2.
 */
export interface ExactAuthorizationWire {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

/** The `payload` a client sends for an `exact` rail: an EIP-3009 signature + its authorization. */
export interface ExactPaymentPayload {
  signature: string
  authorization: ExactAuthorizationWire
}

/**
 * The `permit2Authorization` a payer signs for the `permit2` variant of the x402
 * `exact` EVM scheme (tokens without EIP-3009 — e.g. Binance-Peg USDC on BNB). It is
 * an EIP-712 `PermitWitnessTransferFrom` over the canonical Permit2 contract, whose
 * `spender` is the canonical **x402ExactPermit2Proxy** and whose **witness** binds the
 * recipient (`to`) + an activation time (`validAfter`). All numeric fields are DECIMAL
 * strings on the wire (`permitted.amount`, `nonce`, `deadline`, `witness.validAfter`).
 */
export interface Permit2Authorization {
  /** What may be pulled: the ERC-20 token + the exact base-unit amount. */
  permitted: { token: string; amount: string }
  /** The payer (token owner). */
  from: string
  /** The signature's allowed spender — the canonical x402ExactPermit2Proxy. */
  spender: string
  /** Permit2 unordered nonce (a uint256, decimal string). Single-use via its bitmap. */
  nonce: string
  /** Unix-seconds signature expiry. */
  deadline: string
  /** The proxy-enforced witness: funds go ONLY to `to`, and not before `validAfter`. */
  witness: { to: string; validAfter: string }
}

/** The `payload` a client sends for the `permit2` exact variant: a signature + its Permit2 authorization. */
export interface Permit2PaymentPayload {
  signature: string
  permit2Authorization: Permit2Authorization
}

/**
 * The `permit2Authorization` a payer signs for the x402 `upto` (metered) EVM scheme.
 * Identical to {@link Permit2Authorization} EXCEPT the witness carries a `facilitator`
 * field as its **MIDDLE** member (`{ to, facilitator, validAfter }`) — the only delta
 * from the exact Permit2 witness. The EIP-712 witness type is
 * `Witness(address to,address facilitator,uint256 validAfter)`. `permitted.amount` is
 * the signed **MAXIMUM**; the merchant settles the ACTUAL (≤ max). `spender` is the
 * canonical **x402UptoPermit2Proxy**. All numeric fields are DECIMAL strings on the wire.
 */
export interface Permit2UptoAuthorization {
  /** What may be pulled: the ERC-20 token + the signed MAXIMUM base-unit amount. */
  permitted: { token: string; amount: string }
  /** The payer (token owner). */
  from: string
  /** The signature's allowed spender — the canonical x402UptoPermit2Proxy. */
  spender: string
  /** Permit2 unordered nonce (a uint256, decimal string). Single-use via its bitmap. */
  nonce: string
  /** Unix-seconds signature expiry. */
  deadline: string
  /** The proxy-enforced witness: funds go ONLY to `to`, only the bound `facilitator` can
   *  settle, and not before `validAfter`. `facilitator` is the MIDDLE field. */
  witness: { to: string; facilitator: string; validAfter: string }
}

/** The `payload` a client sends for the `upto` rail: a signature + its Permit2 upto authorization. */
export interface Permit2UptoPaymentPayload {
  signature: string
  permit2Authorization: Permit2UptoAuthorization
}

/**
 * The `payload` a client sends for the **SVM (Solana) `exact`** variant: a base64-encoded,
 * serialized, **partially-signed** versioned Solana transaction (the buyer's `TransferChecked`
 * with the merchant as fee payer; the fee-payer signature slot is left empty for the gate to
 * fill). Per `scheme_exact_svm.md`. The transaction itself IS the proof — there's no separate
 * authorization object (the SVM analogue of EIP-3009's `authorization`).
 */
export interface ExactSvmPaymentPayload {
  transaction: string
}

/**
 * The `payload` a client sends for the **Algorand `exact`** variant, per
 * `scheme_exact_algo.md`: an atomically-grouped set of base64-encoded msgpack transactions,
 * and the index within it of the transaction that pays the resource server. The buyer's ASA
 * `axfer` (to `payTo`, fee 0) is SIGNED; a 0-ALGO `pay` from the `feePayer` that pools the
 * group fee is left UNSIGNED for whoever sponsors (the gate's relayer in self mode, or a
 * keyless facilitator). The group itself IS the proof — there's no separate authorization
 * object (the Algorand analogue of EIP-3009's `authorization` / SVM's `transaction`).
 */
export interface ExactAlgorandPaymentPayload {
  /** Index into `paymentGroup` of the txn that pays the resource server (the buyer's `axfer`). */
  paymentIndex: number
  /** The atomic group: each element is a base64-encoded, msgpack-encoded (signed or unsigned)
   *  Algorand transaction. ≤ 16 elements (the protocol's atomic-group cap). */
  paymentGroup: string[]
}

/**
 * The `payload` a client sends for the **Aptos `exact`** variant, per `scheme_exact_aptos.md`:
 * a fee-payer (sponsored, AIP-39) `primary_fungible_store::transfer`. `transaction` is the base64
 * BCS-serialized `SimpleTransaction` (raw tx + the bound `feePayerAddress`); `senderAuth` is the
 * base64 BCS-serialized buyer (sender) authenticator. The buyer leaves the fee-payer signature for
 * whoever sponsors (the gate's relayer in self mode, or a keyless facilitator), who adds it +
 * submits. The (tx + sender authenticator) IS the proof — there's no separate `authorization`
 * object (the Aptos analogue of EIP-3009's `authorization` / SVM's `transaction`). The two-field
 * shape (a `senderAuth` alongside `transaction`) also distinguishes it from the SVM payload.
 */
export interface ExactAptosPaymentPayload {
  /** Base64 BCS-serialized `SimpleTransaction` (raw transaction + the bound `feePayerAddress`). */
  transaction: string
  /** Base64 BCS-serialized buyer (sender) `AccountAuthenticator`. */
  senderAuth: string
}

/**
 * The `payload` a client sends for the **NEAR `exact`** variant, per `scheme_exact_near.md`:
 * a base64-encoded, Borsh-serialized NEP-366 `SignedDelegateAction` whose single delegated action
 * is one NEP-141 `ft_transfer` (to `payTo`, the exact `amount`, `deposit: 1` yoctoNEAR). The buyer
 * signs the delegate action with a FULL-ACCESS key (a function-call key can't attach the 1 yocto and
 * is rejected); a facilitator-selected relayer wraps it, prepays gas + the yocto, and submits. The
 * signed delegate action IS the proof — there's no separate authorization object (the NEAR analogue
 * of EIP-3009's `authorization` / SVM's `transaction`). Its single self-contained string field also
 * distinguishes it from every other family's payload shape.
 */
export interface ExactNearPaymentPayload {
  /** Base64 of the Borsh-encoded NEP-366 `SignedDelegateAction` (one `ft_transfer`). */
  signedDelegateAction: string
}

/** Any `exact`-rail payload shape — EIP-3009 (`authorization`), Permit2 (`permit2Authorization`),
 *  SVM (`transaction`), Algorand (`paymentGroup`), Aptos (`transaction` + `senderAuth`), or NEAR
 *  (`signedDelegateAction`). */
export type ExactPaymentPayloadAny =
  | ExactPaymentPayload
  | Permit2PaymentPayload
  | ExactSvmPaymentPayload
  | ExactAlgorandPaymentPayload
  | ExactAptosPaymentPayload
  | ExactNearPaymentPayload

interface ParsedExactBase {
  x402Version: number
  /** The client's claimed network (slug or CAIP-2) — for matching, not trust. */
  network: string
  /** The client's claimed asset, if present (v2 `accepted.asset`). */
  asset?: string
  /** The full decoded PaymentPayload, for verbatim forwarding to a facilitator (Mode B). */
  raw: Record<string, unknown>
}

/**
 * What {@link parseExactPaymentHeader} extracts from an inbound `exact` payment,
 * normalised across the v1 (`X-PAYMENT`, flat `{scheme,network,payload}`, network slug)
 * and v2 (`PAYMENT-SIGNATURE`, `{accepted,payload}`, CAIP-2 network) wire shapes.
 * `network`/`asset` are the CLIENT's claim — used only to MATCH an offered rail; the gate
 * re-derives every verified field from its own trusted rail. A discriminated union on
 * `method`, so narrowing on `method` narrows `payload`: `'eip3009'` → {@link ExactPaymentPayload}
 * (`authorization`), `'permit2'` → {@link Permit2PaymentPayload} (`permit2Authorization`),
 * `'svm'` → {@link ExactSvmPaymentPayload} (`transaction`), `'algorand'` →
 * {@link ExactAlgorandPaymentPayload} (`paymentGroup`); `'aptos'` →
 * {@link ExactAptosPaymentPayload} (`transaction` + `senderAuth`); `'near'` →
 * {@link ExactNearPaymentPayload} (`signedDelegateAction`).
 */
export type ParsedExactPayment =
  | (ParsedExactBase & { method: 'eip3009'; payload: ExactPaymentPayload })
  | (ParsedExactBase & { method: 'permit2'; payload: Permit2PaymentPayload })
  | (ParsedExactBase & { method: 'svm'; payload: ExactSvmPaymentPayload })
  | (ParsedExactBase & { method: 'algorand'; payload: ExactAlgorandPaymentPayload })
  | (ParsedExactBase & { method: 'aptos'; payload: ExactAptosPaymentPayload })
  | (ParsedExactBase & { method: 'near'; payload: ExactNearPaymentPayload })

/**
 * What {@link parseUptoPaymentHeader} extracts from an inbound `upto` payment — the
 * metered-rail sibling of {@link ParsedExactPayment}. A single PipRail-internal
 * `method: 'permit2-upto'` discriminant (the on-wire `scheme` is `'upto'`). `network`/
 * `asset` are the CLIENT's claim — used only to MATCH an offered rail; the gate re-derives
 * every verified field from its own trusted rail. Kept separate from the exact parse path
 * so an upto payload (scheme `'upto'`, witness carries `facilitator`) never matches the
 * exact parser and vice-versa.
 */
export type ParsedUptoPayment = ParsedExactBase & {
  method: 'permit2-upto'
  payload: Permit2UptoPaymentPayload
}

export interface X402Receipt {
  scheme: 'onchain-proof' | 'exact' | 'upto'
  /**
   * x402 v2 SettlementResponse: settlement succeeded. Always `true` here — a
   * failed verification returns a 402, never a receipt.
   */
  success: true
  network: Caip2
  /**
   * x402 v2 SettlementResponse: the on-chain transaction id of the SETTLED
   * payment — a chain-specific id (an EVM/Tron/Stellar/XRPL/NEAR tx hash, a
   * Solana signature, or a Sui digest). This is the verified tx itself, NOT the
   * submit-time proof ref in `payload.txHash` (which can be a composite locator
   * on TON/NEAR). (Was `txHash` before v2 envelope conformance.)
   */
  transaction: string
  asset: AssetId
  amount: string
  payer: AddressId
  payTo: AddressId
  verifiedAt: string
  /**
   * NEW (additive, optional). The challenge nonce this settlement was bound to —
   * the value `genNonce()` minted into the 402 and echoed back as the buyer's
   * `payload.nonce` (NOT an exact-rail authorization/delegate nonce). REQUIRED to
   * re-verify Template-A families (Stellar/XRPL/NEAR/Algorand/TON) off-chain via a
   * synthetic accept; informational on digest-bound (Template-B) families. Omitted
   * unless the gate's `receipts` option is on, so a default 200 stays byte-identical.
   */
  nonce?: string
}

/**
 * The settled-payment record handed to a gate's `onPaid` hook — the wire
 * {@link X402Receipt} plus the merchant-facing extras the gate already computed
 * for the challenge, so a receipt handler never needs a second lookup to display
 * or reconcile it: the token's `decimals`/`symbol`, the human `amountFormatted`
 * (derived from the SETTLED base-unit `amount`, not the requested price), and a
 * stable `idempotencyKey`.
 *
 * **Delivery contract — read this before persisting receipts.** `onPaid` is
 * **at-least-once**: with a single in-memory replay store it fires exactly once
 * per proof, but across instances sharing a custom `isUsed`/`markUsed` store two
 * nodes can settle the same proof in a race and each fire once. Always **dedupe on
 * `idempotencyKey`** (a unique index / upsert). It is also fire-and-forget by
 * default — the gate does not block the response on it and a process crash between
 * settlement and your side-effect drops that receipt. For durability either set
 * `awaitOnPaid` (record before the 200) or push to a durable queue inside the hook;
 * for a webhook, use {@link deliverReceipt} (signed, retried, idempotent).
 */
export interface PaidReceipt extends X402Receipt {
  /** The token's on-chain decimals — pairs with `amount` so you can format without a lookup. */
  decimals: number
  /** The token symbol when the gate knows it (e.g. `USDC`, `FDUSD`). */
  symbol?: string
  /** Human-readable settled amount, e.g. `"0.05"` — `amount` / 10**`decimals`. */
  amountFormatted: string
  /**
   * A stable, unique key for this settlement (the settled `transaction` id). `onPaid`
   * is at-least-once across instances — dedupe persistence and webhook delivery on this.
   */
  idempotencyKey: string
}

/**
 * The OPTIONAL Tier-2 EIP-712 delivery attestation — the official offer-receipt
 * `SignedReceipt`. Populated only when the merchant enables `receipts: { attest }`
 * (a separate phase); absent for Tier-1 chain-grounded receipts. Kept open for
 * forward-compat with the spec's typed-data fields, filled in by the EVM
 * `signReceipt` SPI; verification is `PipRailClient.verifyAttestation`.
 */
export interface SignedReceipt {
  /** The EIP-712 signature over the receipt typed-data. */
  signature: string
  /** The recovered signer the verifier expects to equal the merchant `payTo`. */
  signer: AddressId
  [extra: string]: unknown
}

/**
 * The self-contained, portable receipt a buyer KEEPS and **anyone** re-verifies
 * against the chain with only an RPC — no key, no backend, no PipRail account.
 * It bundles the verified {@link X402Receipt} (which carries `nonce` for Template-A
 * re-verification) with the reconstruction metadata a third party needs to rebuild
 * the trusted accept and re-run the driver's `verify()`: what was paid for
 * (`resource`) and the asset `decimals` (Stellar/XRPL/TON need it to re-scale the
 * amount). Rides the wire in `extensions['offer-receipt'].info` on the
 * `PAYMENT-RESPONSE` header; {@link PipRailClient.verifyReceipt} re-verifies it.
 */
export interface PipRailReceipt {
  /** Receipt-format version — distinct from `x402Version`. */
  piprail: '1'
  /** The verified settlement (carries the challenge `nonce` for Template-A re-verify). */
  receipt: X402Receipt
  /** What was paid for — the challenge's resource URL. */
  resource: { url: string }
  /**
   * ADDITIVE. The asset's on-chain decimals — threaded into the synthetic accept's
   * `extra.decimals` so Stellar/XRPL/TON `verify()` can re-scale the wire amount.
   * Receipt-bundle metadata only (the gate already knows it via {@link PaidReceipt});
   * NOT on the minimal wire {@link X402Receipt}.
   */
  decimals?: number
  /** OPTIONAL Tier-2 attestation — present only when the merchant signed it. */
  attestation?: SignedReceipt
}

/**
 * Why a verification failed — a closed, chain-agnostic vocabulary. Every code a
 * driver returns is in this union; a client/agent branches on it rather than
 * parsing prose. Surfaced to the agent in the 402 body's `error` field with a
 * human-readable `detail`. Some codes are family-specific (annotated below):
 * e.g. account-watch chains (TON, Stellar) can't distinguish "wrong recipient"
 * from "no payment", so both collapse to `transfer_not_found`.
 *
 * `transient` = the proof may simply not have propagated to the server's RPC
 * node yet; `definitive` = retrying won't change it. These labels are
 * informational for consumers — the built-in client retries EVERY code up to
 * `maxPaymentRetries` (a short backoff absorbs RPC lag); it does not branch on
 * the code.
 */
export type VerifyErrorCode =
  | 'tx_not_found' // proof tx not on chain yet — transient (RPC lag)
  | 'insufficient_confirmations' // mined, not enough confirmations yet — transient (EVM)
  | 'tx_reverted' // tx is on chain but failed / reverted — definitive
  | 'no_meta' // tx carries no metadata to inspect — definitive (Solana)
  | 'wrong_recipient' // paid, but not to payTo — definitive (EVM/Solana native path)
  | 'amount_too_low' // paid to payTo, but less than required — definitive
  | 'transfer_not_found' // no matching transfer (asset/amount/nonce) to payTo — definitive
  | 'payment_expired' // older than maxTimeoutSeconds (replay window) — definitive
  | 'tx_already_used' // proof already redeemed (replay) — definitive (gate-enforced)
  | 'signature_invalid' // exact rail: the authorization is invalid — EVM: the EIP-712 signature didn't recover to the payer; Solana: the SVM tx signer/structure is invalid — definitive
  | 'upto_settle_exceeds_max' // upto rail: the metered settle amount exceeds the signed MAX (permitted.amount) — definitive (gate/driver-enforced)

/** The shape every driver's `verify()` returns. Shared by drivers + protocol. */
export type VerifyResult =
  | { ok: true; receipt: X402Receipt }
  | { ok: false; error: VerifyErrorCode; detail: string }

export const HEADER_REQUIRED = 'payment-required'
export const HEADER_SIGNATURE = 'payment-signature'
export const HEADER_RESPONSE = 'payment-response'

/*
 * ── x402 protocol version posture (read this before touching anything v1) ──────
 *
 * x402 **v2 REPLACED v1** on the wire — it is not a layer over it: the payment
 * header moved `X-PAYMENT` → `payment-signature`, the 402 challenge moved from a
 * plain JSON body (`maxAmountRequired`, network *slugs* like `base`) into a base64
 * `payment-required` header (`amount`, CAIP-2 `eip155:8453`), and `x402Version`
 * went 1 → 2. The v2 spec is silent on v1; the reference SDKs keep v1 alive only
 * as backward-compat. There is no announced end-of-life.
 *
 * PipRail's stance is **Postel's law — emit strict v2, accept liberal v1 + v2:**
 *   • EMIT  → only v2. Challenges, receipts, and the primary response header are v2.
 *   • ACCEPT → v2 AND v1. The gate also reads the v1 `x-payment` header, the v1 flat
 *              payload shape, `maxAmountRequired`, slug networks, and the v1 `txHash`
 *              receipt field — and echoes the v1 response header too.
 *
 * Why keep v1 *accept* (it is NOT dead weight): the current reference client
 * `@x402/fetch` is v2, but the still-deployed original `x402-fetch` / `x402-express`
 * / `x402-next` / umbrella `x402` packages — and agents pinned to v1 — send v1, and
 * facilitators (e.g. PayAI) still advertise a v1 rail. Dropping v1 *accept* would
 * silently break those payers for zero benefit. It is a sunsettable compat shim,
 * not removable today. (PipRail emits no v1 *body* on its own paths — the v1
 * `x-payment-response` header it sets carries the same v2 receipt body, a header-NAME
 * echo, not a v1-shaped receipt; the lone emitter of a true v1-shape payload is the
 * `encodeXPaymentHeader` UTILITY, whose flat shape every gate + facilitator still accepts.)
 */
export const HEADER_SIGNATURE_V1 = 'x-payment'
export const HEADER_RESPONSE_V1 = 'x-payment-response'

/* ----------------------------- base64 ----------------------------- */
//
// UTF-8 SAFE in every runtime. `btoa`/`atob` are Latin1-only — and modern Node
// defines them globally, so a naive `btoa`-first path silently breaks on any
// non-ASCII byte (a chain error `detail`, a token symbol, an `…` in a viem
// message). We prefer `Buffer` (UTF-8 native) and, where only `btoa`/`atob`
// exist (the browser), bridge through `TextEncoder`/`TextDecoder`.

function encodeBase64(str: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function' && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }
  throw new Error('No base64 encoder available in this runtime.')
}

function decodeBase64(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  if (typeof atob === 'function' && typeof TextDecoder !== 'undefined') {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }
  throw new Error('No base64 decoder available in this runtime.')
}

function fromBase64Json<T>(b64: string): T | null {
  try {
    return JSON.parse(decodeBase64(b64)) as T
  } catch {
    return null
  }
}

/**
 * Decode a base64-JSON wire value into a plain object (or `null` on garbage) — the
 * inverse of {@link buildSignatureHeader}/{@link buildExactSignatureHeader}. Exported
 * so a transport that carries the SAME payload as RAW JSON (A2A) can round-trip a
 * base64 fixture into the object the `…Object` parser cores / `gate.verifyObject` consume.
 */
export function decodeBase64Json(value: string): unknown {
  return fromBase64Json<unknown>(value)
}

function toBase64Json(value: object): string {
  /*
   * JSON.stringify throws a raw TypeError on a BigInt or a circular reference, and both are
   * easy for a caller to hand us — amounts are bigint everywhere INSIDE the SDK, so putting
   * one in a payload is a natural slip rather than an exotic one. ERRORS.md section 1 says a
   * caller-triggerable failure is a typed PipRailError; found by the fuzz sweep, which fed
   * bigints into the header builders and got a bare TypeError back.
   */
  let json: string
  try {
    json = JSON.stringify(value)
  } catch (cause) {
    throw new InvalidConfigError(
      `x402: this payload cannot be serialised to JSON (${(cause as Error).message}). ` +
        `Amounts must be decimal STRINGS, not BigInt — pass '50000', not 50000n.`,
      { cause },
    )
  }
  return encodeBase64(json)
}

/* ----------------------------- network ids ----------------------------- */

/** EVM helper: 56 → "eip155:56". */
export function networkForChain(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`
}

/** EVM helper: "eip155:56" → 56. Returns null on anything else. */
export function chainIdFromNetwork(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network)
  if (!match || !match[1]) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/* ----------------------------- build (server) ----------------------------- */

export function buildChallengeHeader(challenge: X402Challenge): string {
  return toBase64Json(challenge)
}

/**
 * Build the PAYMENT-RESPONSE header from a settled {@link X402Receipt}. When `extensions`
 * is supplied (the gate's `receipts` option is on), it rides as an `extensions` sibling on
 * the SettlementResponse — a standard x402 reader ignores it, {@link parseReceiptExtension}
 * reconstructs the {@link PipRailReceipt}. Omit it (the default) and the header is
 * byte-identical to before this feature.
 */
export function buildReceiptHeader(
  receipt: X402Receipt,
  extensions?: Record<string, unknown>
): string {
  return toBase64Json(extensions ? { ...receipt, extensions } : receipt)
}

/** The x402 extension key for verifiable delivery receipts (the `offer-receipt` extension). */
export const EXT_OFFER_RECEIPT = 'offer-receipt'

/**
 * Assemble the `extensions['offer-receipt']` block for a settled response — PURE
 * JSON, viem-free. SPEC-FAITHFUL placement:
 *  - `info.receipt` holds the official `offer-receipt` **SignedReceipt** (the canonical
 *    `{ format, payload, signature }` a STOCK `@x402/extensions` reader
 *    (`extractReceiptFromResponse` → `info.receipt`) consumes, PLUS an additive `signer` —
 *    the recovered signer address, a convenience a stock reader ignores and a verifier
 *    re-derives from the signature anyway, so it's never trusted on the wire) — present
 *    ONLY when a Tier-2 attestation was signed. When there is no attestation (Tier-1,
 *    chain-grounded) there is no signed artifact, so `info.receipt` is absent — a stock
 *    reader correctly sees "no signed receipt" (because there isn't one).
 *  - `info.settlement` holds PipRail's chain-grounded {@link X402Receipt} (the
 *    settlement record {@link parseReceiptExtension} re-reads for `verifyReceipt`) — a
 *    PipRail-namespaced sibling a stock reader ignores.
 * The optional `schema` JSON-Schema sibling is owner-gated and not emitted by default.
 * The gate merges the returned record into the SettlementResponse's `extensions` on the
 * `PAYMENT-RESPONSE` header.
 */
export function buildReceiptExtension(bundle: {
  receipt: X402Receipt
  resource: { url: string }
  decimals?: number
  attestation?: SignedReceipt
}): Record<string, unknown> {
  const info: Record<string, unknown> = { settlement: bundle.receipt, resource: bundle.resource }
  if (typeof bundle.decimals === 'number') info.decimals = bundle.decimals
  // The SPEC slot: the official SignedReceipt at info.receipt (Tier-2 only). Stock readers read it here.
  if (bundle.attestation) info.receipt = bundle.attestation
  return { [EXT_OFFER_RECEIPT]: { info } }
}

/** The x402 extension key for the optional idempotency identifier (the official
 *  `payment-identifier` extension). A client MAY attach a stable `id` so the server dedupes
 *  retries and rejects a reused id bound to a DIFFERENT payment. */
export const EXT_PAYMENT_IDENTIFIER = 'payment-identifier'

/** id length bounds (spec: 16–128) + the recommended charset. */
const PAYMENT_ID_MIN = 16
const PAYMENT_ID_MAX = 128
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Advertise the `payment-identifier` extension on a 402 challenge — PURE JSON, viem-free. The
 * v2 `{ info, schema }` shape: `info.required:false` (PipRail never MANDATES an id) plus a
 * JSON-Schema bound of {@link PAYMENT_ID_MIN}–{@link PAYMENT_ID_MAX} chars. A client reads this
 * from the challenge and MAY echo an `id` back on its payload; the gate dedupes it on its
 * existing used-proof set. The gate merges this into the challenge `extensions` (a sibling key,
 * never inside `extensions.piprail`).
 */
export function buildPaymentIdentifierAdvertisement(): Record<string, unknown> {
  return {
    [EXT_PAYMENT_IDENTIFIER]: {
      info: { required: false },
      schema: { properties: { id: { type: 'string', minLength: PAYMENT_ID_MIN, maxLength: PAYMENT_ID_MAX } } },
    },
  }
}

/**
 * Read + validate an inbound `payment-identifier` id from a decoded payment-payload object
 * (`payload.extensions['payment-identifier'].info.id`). PURE, NEVER throws. Returns:
 *  - the `id` string when present + valid (16–128 chars, `[A-Za-z0-9_-]`),
 *  - `null` when ABSENT (the id is OPTIONAL — the gate proceeds exactly as without the feature),
 *  - `{ invalid }` when PRESENT but malformed (the gate re-challenges so the buyer can fix it).
 */
export function readPaymentIdentifier(payload: unknown): string | null | { invalid: string } {
  if (typeof payload !== 'object' || payload === null) return null
  const ext = (payload as { extensions?: unknown }).extensions
  if (typeof ext !== 'object' || ext === null) return null
  const block = (ext as Record<string, unknown>)[EXT_PAYMENT_IDENTIFIER]
  if (typeof block !== 'object' || block === null) return null
  const info = (block as { info?: unknown }).info
  if (typeof info !== 'object' || info === null) return null
  const id = (info as { id?: unknown }).id
  if (id === undefined) return null
  if (typeof id !== 'string') return { invalid: 'payment-identifier id must be a string' }
  if (id.length < PAYMENT_ID_MIN || id.length > PAYMENT_ID_MAX) {
    return { invalid: `payment-identifier id must be ${PAYMENT_ID_MIN}–${PAYMENT_ID_MAX} chars (got ${id.length})` }
  }
  if (!PAYMENT_ID_RE.test(id)) {
    return { invalid: 'payment-identifier id must match [A-Za-z0-9_-]' }
  }
  return id
}

/* ----------------------------- build (client) ----------------------------- */

export function buildSignatureHeader(signature: X402PaymentSignature): string {
  // Leave the object ALONE unless there is an `accepted` to clean: the transitional flat shape
  // (top-level `scheme`, no `accepted` at all) must round-trip byte-identically, and spreading in
  // an `accepted: undefined` key would break it.
  if (!signature.accepted) return toBase64Json(signature)
  return toBase64Json({ ...signature, accepted: withoutWireNetwork(signature.accepted) })
}

/**
 * Strip the synthetic {@link X402ExactAcceptEntry.wireNetwork} from a rail about to go back on
 * the wire.
 *
 * Every `accepted` echo is documented as the challenge's rail returned VERBATIM, and
 * facilitators rely on that (some hash the block). `wireNetwork` is the one field that is OURS,
 * not the server's — {@link normalizeV1Challenge} adds it to remember the slug a v1 server sent
 * while `network` is canonicalised to CAIP-2 for matching. Echoing it would hand the merchant a
 * key it never published, so stripping it is what MAKES the echo verbatim. Applied in all three
 * builders because the v1 normalizer tags every accept it lifts, whatever its scheme.
 */
function withoutWireNetwork<T>(accepted: T): T {
  // A hostile/garbage `accepted` (a string, a number, null) reaches here on the fuzzed paths —
  // `in` throws a raw TypeError on a primitive, and ERRORS.md §1 says only typed errors escape.
  // Nothing to strip from a non-object anyway.
  if (accepted === null || typeof accepted !== 'object') return accepted
  if (!('wireNetwork' in accepted)) return accepted
  const { wireNetwork: _wire, ...rest } = accepted as T & { wireNetwork?: string }
  return rest as unknown as T
}

/**
 * Build the v2 PAYMENT-SIGNATURE header value for a standard x402 `exact` payment:
 * base64 of `{ x402Version: 2, accepted, payload }`. `accepted` is the chosen rail
 * echoed back VERBATIM from the challenge's `accepts[]` (preserving any extra keys a
 * facilitator needs); `payload` is the EIP-3009 `{ signature, authorization }` the
 * buyer's EVM driver produced. Chain-agnostic (pure JSON/base64) — the driver owns
 * the signing, this only frames it for the wire. Round-trips through
 * {@link parseExactPaymentHeader}. (The `onchain-proof` counterpart is
 * {@link buildSignatureHeader}; the v1 flat-shape utility is `encodeXPaymentHeader`.)
 */
export function buildExactSignatureHeader(input: {
  accepted: X402ExactAcceptEntry
  payload: ExactPaymentPayloadAny
}): string {
  return toBase64Json({
    x402Version: 2,
    accepted: withoutWireNetwork(input.accepted),
    payload: input.payload,
  })
}

/**
 * Build the v2 PAYMENT-SIGNATURE header value for a standard x402 `upto` (metered)
 * payment: base64 of `{ x402Version: 2, accepted, payload }`. `accepted` is the chosen
 * upto rail echoed back VERBATIM from the challenge's `accepts[]`; `payload` is the
 * Permit2-upto `{ signature, permit2Authorization }` the buyer's EVM driver produced
 * (the witness carries `facilitator`). Chain-agnostic (pure JSON/base64). Round-trips
 * through {@link parseUptoPaymentHeader}. (The `exact` counterpart is
 * {@link buildExactSignatureHeader}.)
 */
export function buildUptoSignatureHeader(input: {
  accepted: X402UptoAcceptEntry
  payload: Permit2UptoPaymentPayload
}): string {
  return toBase64Json({
    x402Version: 2,
    accepted: withoutWireNetwork(input.accepted),
    payload: input.payload,
  })
}

/**
 * Build the **v1** `X-PAYMENT` header value — the flat, pre-v2 payload shape
 * `{ x402Version: 1, scheme, network, payload }`, base64-JSON.
 *
 * This is the `encodeXPaymentHeader` utility the version-posture note above has always
 * described; it had never been written, so the buyer could parse nothing from a v1 server and
 * could answer nothing either. Needed because v2 moved the header `X-PAYMENT` →
 * `PAYMENT-SIGNATURE` and reshaped the payload: a v1 server ignores `PAYMENT-SIGNATURE`
 * entirely (verified live — it just re-challenges) and reads only `X-PAYMENT`.
 *
 * `network` MUST be the slug the v1 server itself sent (`X402ExactAcceptEntry.wireNetwork`),
 * not our canonical CAIP-2: v1 verifiers string-compare it against their own requirement.
 * There is no `accepted` echo in v1 — the chosen rail is identified by these two flat fields.
 */
export function buildV1PaymentHeader(input: {
  scheme: string
  network: string
  payload: unknown
}): string {
  return toBase64Json({
    x402Version: 1,
    scheme: input.scheme,
    network: input.network,
    payload: input.payload,
  })
}

/* ----------------------------- parse ----------------------------- */

/**
 * Parse the PAYMENT-REQUIRED challenge from a 402 response. Prefers the
 * `payment-required` header, falls back to the JSON body.
 */
export async function parseChallenge(
  response: Response
): Promise<X402Challenge | null> {
  const headerValue = response.headers.get(HEADER_REQUIRED)
  if (headerValue) {
    const parsed = fromBase64Json<unknown>(headerValue)
    if (isValidChallenge(parsed)) return parsed
    // A v1 server has no PAYMENT-REQUIRED header (v2 introduced it), but a mixed-version
    // proxy might; lift it the same way. Tried BEFORE the body so header still wins.
    const v1 = normalizeV1Challenge(parsed)
    if (v1) return v1
  }
  try {
    const body = (await response.clone().json()) as unknown
    if (isValidChallenge(body)) return body
    // Postel's law (see the version-posture note): v2 is EMITTED, v1 + v2 are ACCEPTED.
    // Still-deployed v1 servers (x402-fetch/express/next, and agents pinned to v1) send a
    // plain v1 body; refusing it fails a payment we can make. `payExactRail` answers such a
    // challenge on the v1 wire.
    return normalizeV1Challenge(body)
  } catch {
    /* body wasn't JSON */
  }
  return null
}

/** Parse the PAYMENT-RESPONSE receipt header on a 200 settlement. Reads the v2
 *  `payment-response` header, falling back to the v1 `x-payment-response` a foreign
 *  server may set. Returns a fully-formed {@link X402Receipt} only (a bare foreign
 *  exact SettleResponse without a `payer` is read by {@link parseSettleResponse}). */
export function parseReceipt(response: Response): X402Receipt | null {
  const headerValue =
    response.headers.get(HEADER_RESPONSE) ?? response.headers.get(HEADER_RESPONSE_V1)
  if (!headerValue) return null
  const parsed = fromBase64Json<unknown>(headerValue)
  if (!isValidReceipt(parsed)) return null
  // `isValidReceipt` tolerates a legacy v1 receipt carrying only `txHash` (no `transaction`).
  // Normalize that alias to `transaction` so the non-optional `X402Receipt.transaction: string`
  // return type stays honest — otherwise a downstream reader of `.transaction` sees `undefined`.
  const r = parsed as unknown as Record<string, unknown>
  if (typeof r.transaction !== 'string' && typeof r.txHash === 'string') r.transaction = r.txHash
  return r as unknown as X402Receipt
}

/**
 * Read a {@link PipRailReceipt} back from a settled response's `PAYMENT-RESPONSE`
 * header (v2, or the v1 `X-PAYMENT-RESPONSE` fallback). Reads PipRail's chain-grounded
 * settlement record from `extensions['offer-receipt'].info.settlement`, and the optional
 * Tier-2 {@link SignedReceipt} from the spec slot `info.receipt`. Liberal/Postel: TOLERATES
 * + IGNORES a `schema` sibling (or any unknown sibling), and — for robustness — also accepts
 * the settlement record at `info.receipt` if it's there instead (an X402Receipt, distinguished
 * from a SignedReceipt by {@link isValidReceipt}). Returns `null` when no header, no extension
 * block, or no valid settlement record. Pure — no chain read.
 */
export function parseReceiptExtension(response: Response): PipRailReceipt | null {
  const headerValue =
    response.headers.get(HEADER_RESPONSE) ?? response.headers.get(HEADER_RESPONSE_V1)
  if (!headerValue) return null
  const parsed = fromBase64Json<Record<string, unknown>>(headerValue)
  if (!parsed || typeof parsed !== 'object') return null
  const ext = parsed.extensions as Record<string, unknown> | undefined
  const block = ext?.[EXT_OFFER_RECEIPT] as Record<string, unknown> | undefined
  const info = block?.info as Record<string, unknown> | undefined // a `schema` sibling is ignored
  if (!info) return null
  // PipRail's chain-grounded X402Receipt lives at info.settlement; fall back to info.receipt only
  // if THAT holds an X402Receipt (not a SignedReceipt) — isValidReceipt discriminates the two.
  const settlement = isValidReceipt(info.settlement)
    ? info.settlement
    : isValidReceipt(info.receipt)
      ? info.receipt
      : undefined
  if (!settlement) return null
  // The Tier-2 attestation is the SignedReceipt at the spec slot info.receipt — but only when that
  // ISN'T the settlement record itself (the legacy fallback case above).
  const attestation =
    info.receipt && info.receipt !== settlement ? (info.receipt as SignedReceipt) : undefined
  const res = info.resource as { url?: unknown } | undefined
  return {
    piprail: '1',
    receipt: settlement,
    resource: { url: res && typeof res.url === 'string' ? res.url : '' },
    ...(typeof info.decimals === 'number' ? { decimals: info.decimals } : {}),
    ...(attestation ? { attestation } : {}),
  }
}

/**
 * A standard x402 SettleResponse as the BUYER reads it off a settled (non-402)
 * response. The `success` flag is authoritative: `false` is an EXPLICIT facilitator/
 * server REJECTION (the buyer must NOT record a spend), `true` is an affirmative
 * settlement. `transaction` is the on-chain settle tx the facilitator broadcast.
 */
export interface SettleOutcome {
  success: boolean
  transaction?: string
  network?: string
  payer?: string
  errorReason?: string
  /**
   * The ACTUAL settled amount in atomic units, when the SettleResponse carries it
   * (the x402 `upto` scheme makes this field REQUIRED — may be `"0"`). The upto buyer
   * reads it to record the metered ACTUAL spend in its ledger rather than the signed MAX.
   * Absent for `onchain-proof`/`exact` settle responses (they fix the amount up front).
   */
  amount?: string
}

/**
 * Read a standard x402 SettleResponse for the BUYER, from the v2 `payment-response`
 * header (or the v1 `x-payment-response` fallback). Returns `null` when neither
 * header is present, unparseable, or carries no boolean `success` — i.e. when the
 * server served the resource WITHOUT echoing a settle result, which the exact buyer
 * treats as an affirmative 2xx settlement (receipt-less). When a body IS present with
 * a boolean `success`, that flag is returned verbatim: ONLY an explicit
 * `success: false` is a rejection. Used by the exact pay path to tell a real
 * settlement from a phantom one (never record a spend on `success:false`).
 */
export function parseSettleResponse(response: Response): SettleOutcome | null {
  const headerValue =
    response.headers.get(HEADER_RESPONSE) ?? response.headers.get(HEADER_RESPONSE_V1)
  if (!headerValue) return null
  const parsed = fromBase64Json<Record<string, unknown>>(headerValue)
  if (!parsed || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') return null
  return {
    success: parsed.success,
    // Tolerate the legacy v1 `txHash` alias for `transaction` (mirrors isValidReceipt/parseReceipt).
    ...(typeof parsed.transaction === 'string'
      ? { transaction: parsed.transaction }
      : typeof parsed.txHash === 'string'
        ? { transaction: parsed.txHash }
        : {}),
    ...(typeof parsed.network === 'string' ? { network: parsed.network } : {}),
    ...(typeof parsed.payer === 'string' ? { payer: parsed.payer } : {}),
    ...(typeof parsed.errorReason === 'string' ? { errorReason: parsed.errorReason } : {}),
    // The upto SettleResponse's REQUIRED `amount` (actual settled atomic units) — string
    // passthrough so the upto buyer records ACTUAL, not MAX. Absent on onchain-proof/exact.
    ...(typeof parsed.amount === 'string' ? { amount: parsed.amount } : {}),
  }
}

/**
 * Parse an already-decoded `onchain-proof` PaymentPayload OBJECT (server side) —
 * the object-accepting CORE of {@link parseSignatureHeader}. Identical logic to the
 * base64 entry-point below, minus the `fromBase64Json` decode: this is what the A2A
 * transport feeds raw JSON metadata into (A2A carries the payload as raw JSON, not
 * base64), via `gate.verifyObject`. {@link parseSignatureHeader} is the thin base64
 * wrapper — byte-identical to before this split on the HTTP path.
 */
export function parseSignatureObject(parsed: unknown): X402PaymentSignature | null {
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Record<string, unknown>
  // x402 v2 carries the chosen requirement in `accepted`; tolerate the legacy
  // top-level `scheme` shape too so older callers keep parsing.
  const accepted = v.accepted as Record<string, unknown> | undefined
  const scheme = accepted?.scheme ?? v.scheme
  if (scheme !== 'onchain-proof') return null
  const payload = v.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.txHash !== 'string' || typeof payload.nonce !== 'string') {
    return null
  }
  // Type-honesty: the return type declares `accepted` REQUIRED, but the legacy flat shape (top-level
  // `scheme`, no `accepted` object) would otherwise return `accepted: undefined` under the cast. When
  // it's absent, synthesize a minimal `accepted` from the flat fields so a public-API caller can
  // safely read `.accepted.network`/`.asset` without crashing. (The gate re-derives every trusted
  // field from its OWN config regardless, so this is purely about an honest, dereferenceable type.)
  if (!accepted) {
    const synthesized = {
      scheme: 'onchain-proof',
      ...(typeof v.network === 'string' ? { network: v.network } : {}),
      ...(typeof v.asset === 'string' ? { asset: v.asset } : {}),
    }
    return { ...v, accepted: synthesized, payload } as unknown as X402PaymentSignature
  }
  return parsed as X402PaymentSignature
}

/** Parse a PAYMENT-SIGNATURE header value (server side). A thin base64 wrapper over
 *  {@link parseSignatureObject} — byte-identical to before the object-core split. */
export function parseSignatureHeader(value: string): X402PaymentSignature | null {
  return parseSignatureObject(fromBase64Json<unknown>(value))
}

/**
 * Parse an inbound `exact` payment from a base64 header value (`PAYMENT-SIGNATURE`
 * v2 or `X-PAYMENT` v1). Tolerant of BOTH wire shapes — the inner
 * `{ signature, authorization }` payload is identical across versions, so we read
 * `scheme`/`network` from either the v2 `accepted` object or the v1 flat fields.
 * Returns null when the value isn't a recognisable `exact` payment (e.g. it's an
 * `onchain-proof` proof, or malformed).
 */
export function parseExactPaymentHeader(value: string): ParsedExactPayment | null {
  return parseExactObject(fromBase64Json<unknown>(value))
}

/**
 * Parse an already-decoded `exact` PaymentPayload OBJECT — the object-accepting CORE
 * of {@link parseExactPaymentHeader}, identical logic minus the base64 decode. It
 * absorbs the v1/v2 wire skew (the `accepted` wrapper vs flat `scheme`/`network`) and
 * the six exact-method discriminants. The A2A transport feeds raw JSON metadata here
 * (via `gate.verifyObject`); {@link parseExactPaymentHeader} is the thin base64 wrapper,
 * byte-identical to before this split on the HTTP path.
 */
export function parseExactObject(parsed: unknown): ParsedExactPayment | null {
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Record<string, unknown>

  // v2 carries the chosen rail in `accepted`; v1 is flat (scheme/network at top).
  const accepted = (v.accepted ?? null) as Record<string, unknown> | null
  const scheme = (accepted?.scheme ?? v.scheme) as unknown
  if (scheme !== 'exact') return null

  const network = (accepted?.network ?? v.network) as unknown
  if (typeof network !== 'string') return null

  const payload = v.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return null

  const x402Version = typeof v.x402Version === 'number' ? v.x402Version : 2
  const asset = accepted && typeof accepted.asset === 'string' ? accepted.asset : undefined
  const base = { x402Version, network, ...(asset ? { asset } : {}), raw: v }

  // NEAR shape: payload.signedDelegateAction is a single base64 Borsh SignedDelegateAction (no
  // top-level `signature`, no `transaction`/`paymentGroup`). Its unique field name disambiguates it
  // from every other family, so it's checked first.
  if (typeof payload.signedDelegateAction === 'string') {
    return { ...base, method: 'near', payload: { signedDelegateAction: payload.signedDelegateAction } }
  }

  // Aptos shape: payload.transaction + payload.senderAuth (both base64 BCS, no top-level `signature`).
  // Checked BEFORE the SVM branch — SVM also carries `transaction` but NO `senderAuth`, so the extra
  // field disambiguates the two families' single-transaction payloads.
  if (typeof payload.transaction === 'string' && typeof payload.senderAuth === 'string') {
    return { ...base, method: 'aptos', payload: { transaction: payload.transaction, senderAuth: payload.senderAuth } }
  }

  // SVM shape: payload.transaction is a base64 partial-signed tx (no separate `signature` field).
  // Checked FIRST (after Aptos) because, unlike the EVM shapes, it carries no top-level `signature`.
  if (typeof payload.transaction === 'string') {
    return { ...base, method: 'svm', payload: { transaction: payload.transaction } }
  }

  // Algorand shape: payload.paymentGroup is an array of base64 msgpack txns + a paymentIndex
  // (also no top-level `signature`). Validate the shape strictly (every element a string, a
  // sane index inside the ≤16 group) so a malformed group is a clean miss, not a crash.
  if (Array.isArray(payload.paymentGroup)) {
    const group = payload.paymentGroup
    const index = payload.paymentIndex
    if (
      group.length === 0 ||
      group.length > 16 ||
      !group.every((t) => typeof t === 'string') ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= group.length
    ) {
      return null
    }
    return {
      ...base,
      method: 'algorand',
      payload: { paymentIndex: index, paymentGroup: group as string[] },
    }
  }

  const signature = payload.signature
  if (typeof signature !== 'string') return null

  // EIP-3009 shape: payload.authorization { from, to, value, validAfter, validBefore, nonce }.
  const authorization = payload.authorization as Record<string, unknown> | undefined
  if (authorization && typeof authorization === 'object') {
    for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
      if (typeof authorization[k] !== 'string') return null
    }
    return {
      ...base,
      method: 'eip3009',
      payload: { signature, authorization: authorization as unknown as ExactAuthorizationWire },
    }
  }

  // Permit2 shape: payload.permit2Authorization { permitted{token,amount}, from, spender, nonce, deadline, witness{to,validAfter} }.
  const p2 = payload.permit2Authorization as Record<string, unknown> | undefined
  if (p2 && typeof p2 === 'object') {
    const permitted = p2.permitted as Record<string, unknown> | undefined
    const witness = p2.witness as Record<string, unknown> | undefined
    if (!permitted || typeof permitted !== 'object' || !witness || typeof witness !== 'object') return null
    if (typeof permitted.token !== 'string' || typeof permitted.amount !== 'string') return null
    if (typeof witness.to !== 'string' || typeof witness.validAfter !== 'string') return null
    for (const k of ['from', 'spender', 'nonce', 'deadline'] as const) {
      if (typeof p2[k] !== 'string') return null
    }
    return {
      ...base,
      method: 'permit2',
      payload: { signature, permit2Authorization: p2 as unknown as Permit2Authorization },
    }
  }

  return null
}

/**
 * Parse an inbound `upto` (metered) payment from a base64 header value
 * (`PAYMENT-SIGNATURE` v2 or `X-PAYMENT` v1). A SEPARATE parser from
 * {@link parseExactPaymentHeader}, gated strictly on `scheme === 'upto'` AND a
 * `witness.facilitator` STRING — so an upto payload never matches the exact parser and an
 * exact Permit2 payload (no `witness.facilitator`) never matches this one. Returns null
 * when the value isn't a recognisable `upto` payment.
 */
export function parseUptoPaymentHeader(value: string): ParsedUptoPayment | null {
  return parseUptoObject(fromBase64Json<unknown>(value))
}

/**
 * Parse an already-decoded `upto` (metered) PaymentPayload OBJECT — the object-accepting
 * CORE of {@link parseUptoPaymentHeader}, identical logic minus the base64 decode. Gated
 * strictly on `scheme === 'upto'` + a `witness.facilitator` string. The A2A transport feeds
 * raw JSON metadata here (via `gate.verifyObject`); {@link parseUptoPaymentHeader} is the thin
 * base64 wrapper, byte-identical to before this split on the HTTP path.
 */
export function parseUptoObject(parsed: unknown): ParsedUptoPayment | null {
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Record<string, unknown>

  // v2 carries the chosen rail in `accepted`; v1 is flat (scheme/network at top).
  const accepted = (v.accepted ?? null) as Record<string, unknown> | null
  const scheme = (accepted?.scheme ?? v.scheme) as unknown
  if (scheme !== 'upto') return null

  const network = (accepted?.network ?? v.network) as unknown
  if (typeof network !== 'string') return null

  const payload = v.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return null

  const signature = payload.signature
  if (typeof signature !== 'string') return null

  // Permit2-upto shape: payload.permit2Authorization { permitted{token,amount}, from, spender,
  // nonce, deadline, witness{to, FACILITATOR, validAfter} }. The middle `facilitator` field is
  // what distinguishes the upto witness from the exact one — REQUIRE it as a string.
  const p2 = payload.permit2Authorization as Record<string, unknown> | undefined
  if (!p2 || typeof p2 !== 'object') return null
  const permitted = p2.permitted as Record<string, unknown> | undefined
  const witness = p2.witness as Record<string, unknown> | undefined
  if (!permitted || typeof permitted !== 'object' || !witness || typeof witness !== 'object') return null
  if (typeof permitted.token !== 'string' || typeof permitted.amount !== 'string') return null
  if (
    typeof witness.to !== 'string' ||
    typeof witness.facilitator !== 'string' ||
    typeof witness.validAfter !== 'string'
  ) {
    return null
  }
  for (const k of ['from', 'spender', 'nonce', 'deadline'] as const) {
    if (typeof p2[k] !== 'string') return null
  }

  const x402Version = typeof v.x402Version === 'number' ? v.x402Version : 2
  const asset = accepted && typeof accepted.asset === 'string' ? accepted.asset : undefined
  const base = { x402Version, network, ...(asset ? { asset } : {}), raw: v }
  return {
    ...base,
    method: 'permit2-upto',
    payload: { signature, permit2Authorization: p2 as unknown as Permit2UptoAuthorization },
  }
}

function isValidChallenge(value: unknown): value is X402Challenge {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.x402Version !== 2) return false
  if (!Array.isArray(v.accepts) || v.accepts.length === 0) return false
  // Every accepts[] entry must be a non-null OBJECT — a hostile/buggy server sending
  // `accepts: [null, …]` (or a string/number entry) would otherwise reach an unchecked
  // `.scheme` deref in the client + pickAccept and crash with a raw TypeError. A malformed
  // entry makes the whole challenge unparseable → the caller raises InvalidEnvelopeError.
  if (!v.accepts.every((a) => a !== null && typeof a === 'object')) return false
  if (!v.resource || typeof v.resource !== 'object') return false
  return true
}

/**
 * Is this an x402 **v1** challenge body? v1 is structurally distinct from v2, not a subset:
 * `x402Version: 1`, per-accept `maxAmountRequired` (v2 renamed it `amount`), per-accept
 * `resource` STRING (v2 hoists a `resource` object to the top level), and slug networks
 * (`'base'`) instead of CAIP-2. {@link normalizeV1Challenge} lifts it into {@link X402Challenge}.
 */
function isValidV1Challenge(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.x402Version !== 1) return false
  if (!Array.isArray(v.accepts) || v.accepts.length === 0) return false
  if (!v.accepts.every((a) => a !== null && typeof a === 'object')) return false
  // v1's resource lives on the accept, as a string. Require at least one — it becomes the
  // top-level `resource.url` every downstream reader (and the receipt) expects.
  return v.accepts.some((a) => typeof (a as Record<string, unknown>).resource === 'string')
}

/**
 * Lift an x402 **v1** challenge body into the internal {@link X402Challenge} shape, so the
 * whole buyer path downstream of `parseChallenge` stays v2-only and version-blind.
 *
 * Four v1→v2 skews are absorbed, and nothing else is touched (unknown keys ride along
 * verbatim, so a facilitator's extras survive):
 *  1. `maxAmountRequired` → `amount` (v2's rename). An accept that already has `amount` keeps it.
 *  2. slug `network` (`'base'`) → CAIP-2 (`'eip155:8453'`) so the gather's `supports()` matches,
 *     with the ORIGINAL preserved on {@link X402ExactAcceptEntry.wireNetwork} because the v1
 *     server string-compares the slug it sent when we echo it back.
 *  3. per-accept `resource` string → a top-level `resource` object (first accept that has one).
 *  4. `x402Version: 1` is KEPT on the result — it is what tells `payExactRail` to answer on the
 *     v1 wire (`X-PAYMENT`, flat payload) instead of v2's `PAYMENT-SIGNATURE`.
 *
 * Pure: never mutates `body`, never throws (a caller passing a non-v1 value gets `null`).
 */
export function normalizeV1Challenge(body: unknown): X402Challenge | null {
  if (!isValidV1Challenge(body)) return null
  const v = body as Record<string, unknown>
  const rawAccepts = v.accepts as Record<string, unknown>[]

  const accepts = rawAccepts.map((a) => {
    const out: Record<string, unknown> = { ...a }
    // (1) v2 renamed maxAmountRequired → amount. Keep BOTH so a facilitator that reads the
    // legacy name off our echo still finds it; `amount` is what the SDK prices on.
    if (typeof out.amount !== 'string' && typeof a.maxAmountRequired === 'string') {
      out.amount = a.maxAmountRequired
    }
    // (2) canonicalise the network for matching, remembering the wire form for the echo.
    if (typeof a.network === 'string') {
      const canonical = normalizeNetwork(a.network)
      if (canonical !== a.network) {
        out.network = canonical
        out.wireNetwork = a.network
      }
    }
    // (3) the per-accept resource string is hoisted below; drop it from the accept so the
    // echoed rail can't be confused with a v2 `resource` object.
    delete out.resource
    return out as unknown as X402AnyAccept
  })

  const withResource = rawAccepts.find((a) => typeof a.resource === 'string')
  const resource: X402ResourceObject = {
    url: String(withResource?.resource ?? ''),
    ...(typeof withResource?.description === 'string'
      ? { description: withResource.description }
      : {}),
    ...(typeof withResource?.mimeType === 'string' ? { mimeType: withResource.mimeType } : {}),
  }

  return {
    x402Version: 1,
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
    resource,
    accepts,
  }
}

function isValidReceipt(value: unknown): value is X402Receipt {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.scheme !== 'onchain-proof' && v.scheme !== 'exact' && v.scheme !== 'upto') return false
  // v2 SettlementResponse names the proof ref `transaction`; tolerate legacy `txHash`.
  // NB: a $0 upto settle carries `transaction: ""` (empty STRING, never a missing key) per
  // spec §5.3 — `typeof === 'string'` already admits it; do NOT add a non-empty check here.
  if (typeof v.transaction !== 'string' && typeof v.txHash !== 'string') return false
  if (typeof v.payer !== 'string') return false
  return true
}

/* ----------------------------- selection ----------------------------- */

/**
 * Pick the first accepts[] entry on the `onchain-proof` scheme whose network
 * satisfies `matches` (any chain family). Returns null if none match.
 */
export function pickAccept(
  challenge: X402Challenge,
  matches: (network: string) => boolean
): X402AcceptEntry | null {
  for (const accept of challenge.accepts) {
    if (accept.scheme === 'onchain-proof' && matches(accept.network)) return accept
  }
  return null
}
