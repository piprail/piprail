/**
 * ── APTOS SECTION: x402 `exact` scheme — BUYER + SELLER ────────────────────
 *
 * PipRail's own gates default to `onchain-proof` (the buyer broadcasts a normal
 * transfer and proves it with the tx hash). This module is the standard x402
 * `exact` interop for Aptos, in BOTH directions, on the existing
 * `@aptos-labs/ts-sdk` lazy peer (no new dep) — mirroring `drivers/solana/exact.ts`
 * and `drivers/algorand/exact.ts`.
 *
 *   • BUYER side (client) — {@link payExactAptos} builds a **fee-payer (sponsored)**
 *     transaction (AIP-39): a `0x1::primary_fungible_store::transfer` of the FA to
 *     `payTo`, with `withFeePayer` set and the `feePayer` (`accept.extra.feePayer`) bound
 *     as the gas sponsor. The buyer signs ONLY its own (sender) slot and emits
 *     `{ transaction, senderAuth }` (both base64 BCS). The buyer spends ZERO APT — the
 *     fee payer (the merchant's relayer in self mode, or a keyless facilitator) pays gas.
 *
 *   • SELLER side (gate) — {@link verifyAndSettleExactAptos} verifies the inbound
 *     transaction against the trusted `accept` (re-deriving every checked field by DECODING
 *     the entry function), then SELF-SETTLES it: it adds its own fee-payer signature and
 *     submits via the caller's REST node — no third-party facilitator. This is what lets a
 *     PipRail Aptos gate get PAID by any standard x402 `exact` client.
 *
 * The x402 Aptos `exact` scheme (`specs/schemes/exact/scheme_exact_aptos.md`): the client
 * sets the fee payer to `extra.feePayer` and signs; the client's signature covers the whole
 * payload (recipient/amount/asset), so the fee payer can ONLY add its signature — any tamper
 * invalidates it. Aptos is one-shot (no gas-station round-trip): the buyer needs only the
 * advertised `feePayer` to sign. Replay is chain-enforced by the sender's monotonic
 * SEQUENCE NUMBER (the Aptos analogue of EIP-3009's nonce) — plus the gate's own used set.
 *
 * Unlike Solana (whose fee payer must NOT appear in any instruction), the Aptos fee payer is a
 * pure gas sponsor outside the transfer, so `feePayer === payTo` is allowed (a merchant happily
 * pays its own receive gas while the buyer stays gasless). Only `feePayer === payer` is
 * forbidden — that would have the buyer pay gas, defeating the whole point.
 *
 * Native APT is NOT exact-payable here (the rail is defined over an FA `transfer` whose metadata
 * is bound to the trusted asset); native stays `onchain-proof`, exactly as EVM/Solana/Algorand
 * exclude their native coin.
 */
import {
  AccountAddress,
  AccountAuthenticator,
  AccountAuthenticatorEd25519,
  Deserializer,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  generateSigningMessageForTransaction,
  type AccountPublicKey,
} from '@aptos-labs/ts-sdk'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import type {
  ExactAptosPaymentPayload,
  VerifyErrorCode,
  VerifyResult,
  X402ExactAcceptEntry,
} from '../../x402.js'

/** The ONLY entry function the rail accepts — the canonical FA transfer (same one onchain-proof uses). */
const TRANSFER_MODULE = '0x1::primary_fungible_store'
const TRANSFER_FUNCTION = 'transfer'
const METADATA_TYPE = '0x1::fungible_asset::Metadata'

/** The buyer's default gas ceiling — matches the onchain-proof path (enough for a transfer that even
 *  CREATES the recipient's primary store, while keeping the fee payer's up-front reservation small). */
const BUYER_MAX_GAS_AMOUNT = 50_000

/** Inbound caps that bound the fee payer's exposure (a malicious buyer could otherwise set a huge
 *  `max_gas_amount × gas_unit_price`, forcing the sponsor to reserve — and risk being charged — a
 *  large sum). The structural check already pins the tx to a ~5k-gas transfer, so these are generous
 *  ceilings, not tight limits: 100k units × 2000 octas/unit = 200_000_000 octas ⇒ ≤ 2 APT worst-case
 *  reservation (8-decimal octas). The reservation is released post-tx; the structural ~5k-gas pin means
 *  the actual charge stays sub-cent — the cap is a finite backstop, not the real cost. */
const MAX_GAS_AMOUNT_CAP = 100_000n
const MAX_GAS_UNIT_PRICE_CAP = 2_000n

const b64encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** Parse + canonicalize an Aptos address; returns null when invalid (never throws). */
function parseAddr(addr: string): AccountAddress | null {
  try {
    return AccountAddress.fromString(addr)
  } catch {
    return null
  }
}

/* ───────────────────────────── BUYER SIDE (client) ───────────────────────────── */

/**
 * The narrow slice of the Aptos client the BUYER needs — adapted from a real `Aptos` instance in
 * index.ts so this module stays unit-testable with a plain mock. `buildFeePayerTransfer` returns a
 * `withFeePayer` SimpleTransaction (its `feePayerAddress` is set by {@link payExactAptos} after).
 */
export interface AptosExactPayClient {
  buildFeePayerTransfer(input: {
    sender: string
    metadata: string
    payTo: string
    amount: string
    maxGasAmount: number
  }): Promise<SimpleTransaction>
  signAsSender(input: { transaction: SimpleTransaction }): AccountAuthenticator
}

/**
 * BUYER — build + sign a fee-payer (sponsored) Aptos `exact` payment for a standard x402 `exact`
 * rail. Binds the advertised `extra.feePayer` as the gas sponsor, signs ONLY the sender slot (the
 * buyer spends zero APT), and emits `{ transaction, senderAuth }` (base64 BCS). Returns the payload,
 * the payer address, and a dedupe `nonce` = the buyer's deterministic ed25519 signature (stable
 * across re-presentations of the SAME signed tx).
 *
 * THROWS {@link UnsupportedSchemeError} for native (not exact-payable), a missing/invalid `feePayer`,
 * `feePayer === payer` (the buyer must pay zero APT), or an invalid payTo/asset address.
 */
export async function payExactAptos(input: {
  client: AptosExactPayClient
  /** The buyer's address (the signing Account's address). */
  sender: string
  accept: X402ExactAcceptEntry
}): Promise<{ payload: ExactAptosPaymentPayload; payerFrom: string; nonce: string }> {
  const { client, sender, accept } = input

  if (accept.asset === 'native') {
    throw new UnsupportedSchemeError(
      'Aptos exact is Fungible-Asset only (a primary_fungible_store transfer); native APT is not exact-payable. Pay via onchain-proof.'
    )
  }
  const feePayer = accept.extra.feePayer
  if (!feePayer) {
    throw new UnsupportedSchemeError('Aptos exact rail must advertise extra.feePayer (the gas sponsor address).')
  }
  const feePayerAddr = parseAddr(feePayer)
  if (!feePayerAddr) throw new UnsupportedSchemeError(`Aptos exact: extra.feePayer "${feePayer}" is not a valid Aptos address.`)
  const payToAddr = parseAddr(accept.payTo)
  if (!payToAddr) throw new UnsupportedSchemeError(`Aptos exact: payTo "${accept.payTo}" is not a valid Aptos address.`)
  const metadataAddr = parseAddr(accept.asset)
  if (!metadataAddr) throw new UnsupportedSchemeError(`Aptos exact: asset "${accept.asset}" is not a valid FA metadata address.`)
  const senderAddr = parseAddr(sender)
  if (!senderAddr) throw new UnsupportedSchemeError(`Aptos exact: payer "${sender}" is not a valid Aptos address.`)
  if (feePayerAddr.equals(senderAddr)) {
    throw new UnsupportedSchemeError(
      'Aptos exact: the fee payer must differ from the payer — the buyer must pay ZERO APT (the sponsor pays gas).'
    )
  }

  const tx = await client.buildFeePayerTransfer({
    sender,
    metadata: metadataAddr.toString(),
    payTo: payToAddr.toString(),
    amount: accept.amount,
    maxGasAmount: BUYER_MAX_GAS_AMOUNT,
  })
  // Bind the advertised sponsor BEFORE signing, so the sender's signature commits to this fee payer.
  tx.feePayerAddress = feePayerAddr
  const senderAuth = client.signAsSender({ transaction: tx })

  return {
    payload: { transaction: b64encode(tx.bcsToBytes()), senderAuth: b64encode(senderAuth.bcsToBytes()) },
    payerFrom: sender,
    nonce: dedupeNonce(senderAuth),
  }
}

/** A stable, unique dedupe id for a signed payment — the buyer's deterministic ed25519 signature
 *  (hex). Falls back to the serialized authenticator bytes for non-ed25519 signers. */
function dedupeNonce(auth: AccountAuthenticator): string {
  if (auth instanceof AccountAuthenticatorEd25519) return auth.signature.toString()
  return b64encode(auth.bcsToBytes())
}

/* ───────────────────────────── SELLER SIDE (gate) ────────────────────────────── */

function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

function fail(error: VerifyErrorCode, detail: string): VerifyResult {
  return { ok: false, error, detail }
}

/** The narrow network surface the SELLER needs — adapted from a real `Aptos` instance in index.ts
 *  so this module stays unit-testable with a plain mock. The adapter closes over the fee-payer
 *  Account (so `signAsFeePayer` + the fee-payer public key in `simulate` are encapsulated). */
export interface AptosExactSettleClient {
  /** Sign the (deserialized) tx as the fee payer; resolve the fee-payer authenticator. */
  signAsFeePayer(input: { transaction: SimpleTransaction }): AccountAuthenticator
  /** Simulate the fully-formed fee-payer tx (no broadcast). `senderPublicKey` is the buyer's
   *  on-tx key. Resolve `{ success, vmStatus }`; THROWS only on a transient RPC error (treated
   *  as non-blocking — submit re-validates). */
  simulate(input: { transaction: SimpleTransaction; senderPublicKey: AccountPublicKey }): Promise<{ success: boolean; vmStatus: string }>
  /** Submit the fully-signed fee-payer tx; resolve the on-chain tx hash. THROWS on submit error. */
  submit(input: {
    transaction: SimpleTransaction
    senderAuthenticator: AccountAuthenticator
    feePayerAuthenticator: AccountAuthenticator
  }): Promise<string>
  /** Wait for `hash` to commit; resolve `{ success }`, or null if it didn't land in time. */
  waitForConfirmation(hash: string): Promise<{ success: boolean } | null>
}

/** Read the raw BCS bytes of a deserialized entry-function argument (an EntryFunctionBytes wrapping
 *  a FixedBytes). Throws on an unexpected shape (→ caller maps to a clean verify failure). */
function argBytes(arg: unknown): Uint8Array {
  const v = (arg as { value?: { value?: unknown } }).value?.value
  if (v instanceof Uint8Array) return v
  throw new Error('unexpected entry-function argument shape')
}

/**
 * SELLER — verify an inbound Aptos `exact` payment against the trusted `accept`, then SELF-SETTLE
 * it: add the fee-payer signature and submit via the caller's REST node. The trusted `accept` (the
 * gate's own rail) is the SOLE source of truth for payTo / amount / asset / feePayer — the client's
 * transaction is only DECODED and bound against it.
 *
 * RETURNS a {@link VerifyResult}: `{ ok:false, error }` for a CLIENT-fixable fault (the gate replies
 * 402); `{ ok:true, receipt }` once the settle tx confirms. THROWS {@link SettlementError} for a
 * SERVER-side settle failure (a VALID tx that fails to submit/confirm — node down, fee payer out of
 * APT) or a gate misconfiguration → the gate replies 5xx and the buyer's signed tx stays valid.
 */
export async function verifyAndSettleExactAptos(input: {
  client: AptosExactSettleClient
  /** The gate relayer's address (= `accept.extra.feePayer`). */
  feePayerAddr: string
  payload: ExactAptosPaymentPayload
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { client, feePayerAddr, payload, accept } = input

  // --- C0. Config guards (the gate's own faults → throw, never a 402) ---
  const railFeePayer = accept.extra.feePayer
  if (!railFeePayer) throw new SettlementError('Aptos exact: rail is missing extra.feePayer.')
  if (railFeePayer !== feePayerAddr) {
    throw new SettlementError('Aptos exact: the gate relayer address does not match the rail extra.feePayer — misconfigured rail.')
  }
  if (accept.asset === 'native') throw new SettlementError('Aptos exact: native APT is not exact-payable (misconfigured rail).')
  const railFeePayerAddr = parseAddr(railFeePayer)
  const railPayTo = parseAddr(accept.payTo)
  const railMetadata = parseAddr(accept.asset)
  if (!railFeePayerAddr || !railPayTo || !railMetadata) {
    throw new SettlementError('Aptos exact: rail feePayer/payTo/asset is not a valid Aptos address (misconfigured rail).')
  }

  // --- C1. Deserialize the transaction + the sender authenticator ---
  let tx: SimpleTransaction
  let senderAuth: AccountAuthenticator
  try {
    tx = SimpleTransaction.deserialize(new Deserializer(b64decode(payload.transaction)))
    senderAuth = AccountAuthenticator.deserialize(new Deserializer(b64decode(payload.senderAuth)))
  } catch (err) {
    return fail('signature_invalid', `Unparseable Aptos transaction/authenticator: ${shorten(err instanceof Error ? err.message : String(err))}.`)
  }
  const raw = tx.rawTransaction

  // --- C2. Structural bind to the trusted accept (the security boundary) ---
  // C2a. The fee payer baked into the tx must be the trusted rail fee payer (the buyer's signature
  //      committed to it), so the gate only sponsors a tx that named the gate as the sponsor.
  if (!tx.feePayerAddress || !tx.feePayerAddress.equals(railFeePayerAddr)) {
    return fail('signature_invalid', `The transaction fee payer ${tx.feePayerAddress?.toString() ?? '(none)'} is not the rail fee payer ${railFeePayer}.`)
  }
  // C2b. Exactly the canonical FA transfer entry function — nothing else can execute.
  const payloadKind = raw.payload
  if (!(payloadKind instanceof TransactionPayloadEntryFunction)) {
    return fail('transfer_not_found', 'The transaction is not an entry-function call.')
  }
  const ef = payloadKind.entryFunction
  const fnId = `${ef.module_name.address.toString()}::${ef.module_name.name.identifier}`
  if (fnId !== TRANSFER_MODULE || ef.function_name.identifier !== TRANSFER_FUNCTION) {
    return fail('transfer_not_found', `Not a ${TRANSFER_MODULE}::${TRANSFER_FUNCTION} call (got ${fnId}::${ef.function_name.identifier}).`)
  }
  if (ef.type_args.length !== 1 || ef.type_args[0]!.toString() !== METADATA_TYPE) {
    return fail('transfer_not_found', `Transfer type argument is not <${METADATA_TYPE}>.`)
  }
  if (ef.args.length !== 3) {
    return fail('transfer_not_found', `Transfer expects 3 arguments (metadata, recipient, amount), got ${ef.args.length}.`)
  }
  // C2c. Decode + bind the three args: metadata, recipient, amount.
  let metadata: AccountAddress, recipient: AccountAddress, amount: bigint
  try {
    metadata = AccountAddress.deserialize(new Deserializer(argBytes(ef.args[0])))
    recipient = AccountAddress.deserialize(new Deserializer(argBytes(ef.args[1])))
    amount = new Deserializer(argBytes(ef.args[2])).deserializeU64()
  } catch (err) {
    return fail('transfer_not_found', `Could not decode the transfer arguments: ${shorten(err instanceof Error ? err.message : String(err))}.`)
  }
  if (!metadata.equals(railMetadata)) {
    return fail('transfer_not_found', `Transfer asset ${metadata.toString()} ≠ rail asset ${accept.asset}.`)
  }
  if (!recipient.equals(railPayTo)) {
    return fail('wrong_recipient', `Transfer pays ${recipient.toString()}, not payTo ${accept.payTo}.`)
  }
  if (amount < BigInt(accept.amount)) {
    return fail('amount_too_low', `Transfer pays ${amount} of the FA, required ${accept.amount}.`)
  }
  // C2d. Bound the fee payer's gas exposure (a malicious buyer can't force a huge reservation).
  if (raw.max_gas_amount > MAX_GAS_AMOUNT_CAP) {
    return fail('signature_invalid', `max_gas_amount ${raw.max_gas_amount} exceeds the cap ${MAX_GAS_AMOUNT_CAP} (fee-payer drain guard).`)
  }
  if (raw.gas_unit_price > MAX_GAS_UNIT_PRICE_CAP) {
    return fail('signature_invalid', `gas_unit_price ${raw.gas_unit_price} exceeds the cap ${MAX_GAS_UNIT_PRICE_CAP} (fee-payer drain guard).`)
  }
  // C2e. Cheap early-out for an already-expired tx (the chain enforces it authoritatively at submit).
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (raw.expiration_timestamp_secs <= now) {
    return fail('payment_expired', `Transaction expired: expiration ${raw.expiration_timestamp_secs} <= now ${now}.`)
  }

  // --- C3. Verify the sender signature OFF-CHAIN (catch a forgery before any network call). The
  //     buyer signed over THIS tx (feePayer = rail fee payer), so the message matches. For a
  //     non-ed25519 signer we defer to submit (the chain verifies it) rather than reject. ---
  const payer = raw.sender.toString()
  if (senderAuth instanceof AccountAuthenticatorEd25519) {
    let sigOk = false
    try {
      const message = generateSigningMessageForTransaction(tx)
      sigOk = senderAuth.public_key.verifySignature({ message, signature: senderAuth.signature })
    } catch (err) {
      return fail('signature_invalid', `Could not verify the sender signature: ${shorten(err instanceof Error ? err.message : String(err))}.`)
    }
    if (!sigOk) return fail('signature_invalid', 'The sender signature does not verify over the transaction.')
    // The signing key must own the sender account (else a valid sig over a foreign sender).
    if (senderAuth.public_key.authKey().derivedAddress().toString() !== payer) {
      return fail('signature_invalid', 'The sender signature key does not derive to the transaction sender.')
    }
  }

  // --- C4. Sign as the fee payer (the gate sponsors gas). A failure here is the gate's own fault. ---
  let feePayerAuth: AccountAuthenticator
  try {
    feePayerAuth = client.signAsFeePayer({ transaction: tx })
  } catch (err) {
    throw new SettlementError(`Aptos exact settle: the gate could not sign as fee payer (${shorten(err instanceof Error ? err.message : String(err))}).`, { cause: err })
  }

  // --- C5. Simulate BEFORE submit — confirms the tx would succeed (sufficient balance, no revert),
  //     costing nothing. Best-effort: only when we have the buyer's ed25519 key; a transient sim RPC
  //     failure does NOT block (submit re-validates everything). ---
  if (senderAuth instanceof AccountAuthenticatorEd25519) {
    try {
      const sim = await client.simulate({ transaction: tx, senderPublicKey: senderAuth.public_key })
      if (!sim.success) {
        const m = sim.vmStatus
        if (/EXPIRED|expired/i.test(m)) return fail('payment_expired', `Transaction would fail: ${shorten(m)}.`)
        if (/SEQUENCE_NUMBER_TOO_OLD|already/i.test(m)) return fail('tx_already_used', `This payment was already settled: ${shorten(m)}.`)
        if (/INSUFFICIENT/i.test(m)) return fail('tx_reverted', `Insufficient balance to settle: ${shorten(m)}.`)
        return fail('tx_reverted', `Transaction would fail on-chain: ${shorten(m)}.`)
      }
    } catch {
      // Transient simulate failure — don't block; submit re-validates below.
    }
  }

  // --- C6. SUBMIT (settle). A failure of a VALID tx is SERVER-side → SettlementError (gate 5xx),
  //     EXCEPT a client-fixable cause (bad sig / expired / stale sequence) surfaced in the error. ---
  let hash: string
  try {
    hash = await client.submit({ transaction: tx, senderAuthenticator: senderAuth, feePayerAuthenticator: feePayerAuth })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    if (/signature|invalid.*auth|INVALID_SIGNATURE/i.test(m)) return fail('signature_invalid', `Settle rejected — bad signature: ${shorten(m)}.`)
    if (/SEQUENCE_NUMBER_TOO_OLD|already.*(committed|ledger)|duplicate/i.test(m)) return fail('tx_already_used', `This payment was already settled: ${shorten(m)}.`)
    if (/EXPIRED|expired|TOO_NEW/i.test(m)) return fail('payment_expired', `Settle rejected — expired/stale: ${shorten(m)}.`)
    throw new SettlementError(
      `Aptos exact settle: the transaction failed to submit (${shorten(m)}). The buyer's signed transaction is still ` +
        `valid — fund/fix the fee payer (${railFeePayer}) and the buyer can re-present it.`,
      { cause: err }
    )
  }

  // --- C7. Confirm (sub-second finality). A timeout is server-side (likely landed) → throw. ---
  let confirmed: { success: boolean } | null
  try {
    confirmed = await client.waitForConfirmation(hash)
  } catch (err) {
    throw new SettlementError(`Aptos exact settle: submitted ${hash} but confirmation read failed (${shorten(err instanceof Error ? err.message : String(err))}). It likely landed — re-verify before re-presenting; do NOT re-pay.`, { cause: err })
  }
  if (confirmed === null) {
    throw new SettlementError(`Aptos exact settle: submitted ${hash} but it did not confirm in time. It likely landed — re-verify before re-presenting; do NOT re-pay.`)
  }
  if (!confirmed.success) {
    return fail('tx_reverted', `Settle tx ${hash} reverted on-chain (a post-simulate race).`)
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: hash,
      asset: accept.asset,
      amount: accept.amount,
      payer,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
