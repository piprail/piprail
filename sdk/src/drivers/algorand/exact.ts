/**
 * ── ALGORAND SECTION: x402 `exact` scheme — BUYER + SELLER ─────────────────
 *
 * PipRail's own gates default to `onchain-proof` (the buyer broadcasts a normal
 * transfer and proves it with the note nonce). This module is the standard x402
 * `exact` interop for Algorand, in BOTH directions, on the existing `algosdk`
 * lazy peer (no new dep) — mirroring `drivers/solana/exact.ts`.
 *
 *   • BUYER side (client) — {@link payExactAlgorand} builds the buyer's ASA `axfer`
 *     to `payTo` at **fee 0**, atomically grouped with a 0-ALGO `pay` from the
 *     `feePayer` (`accept.extra.feePayer`) whose fee POOLS the whole group, signs
 *     ONLY the axfer, and emits `{ paymentIndex, paymentGroup }` (base64 msgpack).
 *     The buyer spends ZERO ALGO — the fee payer (the merchant's relayer in self
 *     mode, or a keyless facilitator) pays the pooled fee to settle.
 *
 *   • SELLER side (gate) — {@link verifyAndSettleExactAlgorand} verifies the inbound
 *     group against the trusted `accept` (re-deriving every checked field), then
 *     SELF-SETTLES it: it co-signs the fee `pay` txn as the fee payer and submits the
 *     group via the caller's algod — no third-party facilitator. This is what lets a
 *     PipRail Algorand gate get PAID by any standard x402 `exact` client.
 *
 * The x402 Algorand `exact` scheme (`specs/schemes/exact/scheme_exact_algo.md`):
 * Algorand has no per-account "fee payer" slot like Solana — instead a transaction
 * group POOLS fees, so one txn can over-pay and cover a fee-0 sibling. The canonical
 * PipRail group is exactly TWO txns — `[buyer axfer (signed, fee 0), feePayer pay
 * (unsigned, fee = group total)]` — assigned a group id BEFORE the buyer signs (so the
 * signature binds the pairing). The seller fills the fee txn's signature and submits;
 * the chain enforces group-id consistency + every signature atomically, so a lifted or
 * substituted txn fails at `simulate`/submit.
 *
 * Unlike Solana (whose fee payer must NOT appear in any instruction — a scheme MUST-rule),
 * Algorand's fee txn is a SEPARATE transaction, so `feePayer === payTo` is allowed (a
 * merchant happily pays its own receive fee while the buyer stays gasless). Only
 * `feePayer === payer` is forbidden — that would have the buyer pay the fee, defeating the
 * whole point.
 *
 * Native ALGO is NOT exact-payable here (the scheme is defined over an ASA `axfer`); native
 * stays `onchain-proof`, exactly as EVM/Solana exclude their native coin.
 */
import algosdk from 'algosdk'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import { parseAlgorandAssetId } from './chains.js'
import type {
  ExactAlgorandPaymentPayload,
  VerifyErrorCode,
  VerifyResult,
  X402ExactAcceptEntry,
} from '../../x402.js'

/** The all-zero Algorand address — an unset close/rekey field. Computed once (lazy module). */
const ZERO_ADDRESS = algosdk.Address.zeroAddress().toString()

/** The canonical PipRail `exact` group is exactly two txns: the buyer's payment + the fee txn. */
const GROUP_SIZE = 2

/**
 * Cap on the fee the SPONSOR (the gate's relayer in self-settle, or a keyless facilitator) will pay
 * on the pooled fee txn. The honest buyer sets it to `minFee × GROUP_SIZE` (~2000 µALGO at the
 * 1000-µALGO floor); this 20000-µALGO (0.02 ALGO) ceiling is ~10× headroom for any realistic
 * congestion yet far below a drain. WITHOUT it, a malicious buyer could name the sponsor as fee
 * payer and set an arbitrarily large fee — the gate would co-sign + submit it, draining the
 * sponsor's ALGO for a sub-cent transfer. (Mirrors the Aptos rail's gas caps — ERRORS.md §5 / the
 * fee-payer drain guard.) Generous on purpose: a false reject just falls back to onchain-proof.
 */
const MAX_GROUP_FEE = 20_000n

const b64encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** Address-field equality that tolerates algosdk's `Address` objects (v3) and plain strings. */
function addrEq(a: { toString(): string } | string | undefined | null, b: string): boolean {
  return a != null && a.toString() === b
}

/** True when a close/rekey address field is actually SET (present and not the zero address). */
function isSet(addr: { toString(): string } | undefined | null): boolean {
  return addr != null && addr.toString() !== ZERO_ADDRESS
}

/** A CSPRNG 32-byte note for per-payment uniqueness (so the same amount→payTo can be paid
 *  more than once without colliding on a deterministic txid). Universal: Web Crypto in Node
 *  18+ and browsers. Overridable for deterministic tests. */
function randomNote(): Uint8Array {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (!g?.getRandomValues) {
    throw new UnsupportedSchemeError('Algorand exact: no Web Crypto CSPRNG available to generate a unique note.')
  }
  return g.getRandomValues(new Uint8Array(32))
}

/* ───────────────────────────── BUYER SIDE (client) ───────────────────────────── */

/**
 * BUYER — build + partially-sign an Algorand `exact` payment for a standard x402 `exact` rail.
 * Builds the canonical two-txn group `[axfer (buyer→payTo, fee 0), pay (feePayer self, fee =
 * group total)]`, assigns the group id, signs ONLY the buyer's `axfer`, and leaves the fee txn
 * UNSIGNED for whoever sponsors (the gate's relayer in self mode, or a keyless facilitator).
 * Returns the `{ paymentIndex, paymentGroup }` payload, the payer address, and a dedupe `nonce`
 * = the buyer's deterministic txid (stable across re-presentations of the SAME signed group).
 *
 * THROWS {@link UnsupportedSchemeError} for native (not exact-payable), a missing/invalid
 * `feePayer`, `feePayer === payer` (the buyer must pay zero ALGO), or a non-ASA asset.
 */
export async function payExactAlgorand(input: {
  /** Network params for building the txns (genesis hash/id, valid rounds, minFee). */
  suggestedParams: algosdk.SuggestedParams
  /** The buyer's 64-byte secret key. */
  sk: Uint8Array
  /** The buyer's address. */
  sender: string
  accept: X402ExactAcceptEntry
  /** Optional note override (deterministic tests); defaults to a CSPRNG 32-byte note. */
  note?: Uint8Array
}): Promise<{ payload: ExactAlgorandPaymentPayload; payerFrom: string; nonce: string }> {
  const { suggestedParams, sk, sender, accept } = input

  if (accept.asset === 'native') {
    throw new UnsupportedSchemeError(
      'Algorand exact is ASA-only (an asset transfer); native ALGO is not exact-payable. Pay via onchain-proof.'
    )
  }
  const feePayer = accept.extra.feePayer
  if (!feePayer) {
    throw new UnsupportedSchemeError('Algorand exact rail must advertise extra.feePayer (the fee sponsor address).')
  }
  const assetId = parseAlgorandAssetId(accept.asset)
  if (assetId === null) {
    throw new UnsupportedSchemeError(`Algorand exact rail asset "${accept.asset}" must be a numeric ASA id.`)
  }
  if (!algosdk.isValidAddress(feePayer)) {
    throw new UnsupportedSchemeError(`Algorand exact: extra.feePayer "${feePayer}" is not a valid Algorand address.`)
  }
  if (!algosdk.isValidAddress(accept.payTo)) {
    throw new UnsupportedSchemeError(`Algorand exact: payTo "${accept.payTo}" is not a valid Algorand address.`)
  }
  if (feePayer === sender) {
    throw new UnsupportedSchemeError(
      'Algorand exact: the fee payer must differ from the payer — the buyer must pay ZERO ALGO (the sponsor pays the pooled fee).'
    )
  }

  const minFee = suggestedParams.minFee != null ? BigInt(suggestedParams.minFee) : 1000n
  const groupFee = minFee * BigInt(GROUP_SIZE) // the fee txn over-pays to cover the whole group

  // [0] the buyer's ASA transfer to payTo at fee 0; [1] the fee payer's 0-ALGO self-pay whose
  // pooled fee covers the group. paymentIndex = 0 (the txn that pays the resource server).
  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: accept.payTo,
    amount: BigInt(accept.amount),
    assetIndex: assetId,
    note: input.note ?? randomNote(),
    suggestedParams: { ...suggestedParams, flatFee: true, fee: 0n },
  })
  const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feePayer,
    receiver: feePayer,
    amount: 0n,
    suggestedParams: { ...suggestedParams, flatFee: true, fee: groupFee },
  })

  // Group BEFORE signing so the buyer's signature binds the exact pairing (a lifted/substituted
  // sibling changes the group id → the chain rejects the group at simulate/submit).
  algosdk.assignGroupID([axfer, feeTxn])

  const signedAxfer = axfer.signTxn(sk) // signs only the buyer's slot
  const unsignedFee = algosdk.encodeUnsignedTransaction(feeTxn) // left for the sponsor

  return {
    payload: { paymentIndex: 0, paymentGroup: [b64encode(signedAxfer), b64encode(unsignedFee)] },
    payerFrom: sender,
    nonce: axfer.txID(),
  }
}

/* ───────────────────────────── SELLER SIDE (gate) ────────────────────────────── */

function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

function fail(error: VerifyErrorCode, detail: string): VerifyResult {
  return { ok: false, error, detail }
}

/**
 * The narrow network surface the SELLER needs — adapted from a real algod in index.ts so this
 * module stays unit-testable with a plain mock.
 */
export interface AlgorandSettleClient {
  /** Simulate the fully-signed group. Resolve `{ failureMessage }`: a non-empty string when the
   *  group would FAIL (bad signature / would-revert), `null` when it would succeed. THROWS only
   *  on a transient RPC error (the seller treats that as retryable, falling through to submit). */
  simulate(signedGroup: Uint8Array[]): Promise<{ failureMessage: string | null }>
  /** Submit the fully-signed group; resolve the buyer payment txid. THROWS on an RPC/submit error. */
  submit(signedGroup: Uint8Array[]): Promise<string>
  /** Wait for `txid` to confirm; resolve the confirmed round, or `null` if it didn't land in time. */
  waitForConfirmation(txid: string): Promise<number | null>
}

/** One decoded group element: the underlying txn + whether it carried a signature + its raw bytes. */
interface DecodedElement {
  txn: algosdk.Transaction
  signed: boolean
  raw: Uint8Array
}

function decodeElement(bytes: Uint8Array): DecodedElement {
  try {
    const st = algosdk.decodeSignedTransaction(bytes)
    return { txn: st.txn, signed: st.sig != null || st.msig != null || st.lsig != null, raw: bytes }
  } catch {
    // Not a SignedTxn wrapper → a bare (unsigned) transaction.
    return { txn: algosdk.decodeUnsignedTransaction(bytes), signed: false, raw: bytes }
  }
}

/**
 * SELLER — verify an inbound Algorand `exact` payment group against the trusted `accept`, then
 * SELF-SETTLE it: co-sign the fee `pay` txn as the fee payer and submit the group via the
 * caller's algod. The trusted `accept` (the gate's own rail) is the SOLE source of truth for
 * payTo / amount / asset / feePayer — the client's group is only matched + bound against it.
 *
 * RETURNS a {@link VerifyResult}: `{ ok:false, error }` for a CLIENT-fixable fault (the gate
 * replies 402); `{ ok:true, receipt }` once the settle group confirms. THROWS
 * {@link SettlementError} for a SERVER-side settle failure (a VALID group that fails to
 * submit/confirm — algod down, fee payer out of ALGO) or a gate misconfiguration → the gate
 * replies 5xx and the buyer's signed txn stays valid + re-presentable.
 */
export async function verifyAndSettleExactAlgorand(input: {
  client: AlgorandSettleClient
  /** The gate relayer's 64-byte secret key — must control `accept.extra.feePayer`. */
  feePayerSk: Uint8Array
  /** The gate relayer's address (= `accept.extra.feePayer`). */
  feePayerAddr: string
  payload: ExactAlgorandPaymentPayload
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { client, feePayerSk, feePayerAddr, payload, accept } = input

  // --- C0. Config guards (the gate's own faults → throw, never a 402) ---
  const railFeePayer = accept.extra.feePayer
  if (!railFeePayer) throw new SettlementError('Algorand exact: rail is missing extra.feePayer.')
  if (railFeePayer !== feePayerAddr) {
    throw new SettlementError('Algorand exact: the gate relayer address does not match the rail extra.feePayer — misconfigured rail.')
  }
  const assetId = parseAlgorandAssetId(accept.asset)
  if (assetId === null) throw new SettlementError(`Algorand exact: rail asset "${accept.asset}" is not a numeric ASA id.`)
  if (!algosdk.isValidAddress(accept.payTo)) throw new SettlementError(`Algorand exact: rail payTo "${accept.payTo}" is invalid.`)

  // --- C1. Shape: exactly the canonical 2-txn group, a valid paymentIndex ---
  const { paymentIndex, paymentGroup } = payload
  if (paymentGroup.length !== GROUP_SIZE) {
    return fail('signature_invalid', `Algorand exact expects a ${GROUP_SIZE}-transaction group (payment + fee), got ${paymentGroup.length}.`)
  }
  if (!Number.isInteger(paymentIndex) || paymentIndex < 0 || paymentIndex >= GROUP_SIZE) {
    return fail('signature_invalid', `paymentIndex ${paymentIndex} is out of range for a ${GROUP_SIZE}-txn group.`)
  }

  // --- C2. Decode every element (signed or unsigned) ---
  let elements: DecodedElement[]
  try {
    elements = paymentGroup.map((b64) => decodeElement(b64decode(b64)))
  } catch (err) {
    return fail('signature_invalid', `Unparseable Algorand group: ${shorten(err instanceof Error ? err.message : String(err))}.`)
  }
  const payElement = elements[paymentIndex]!
  const feeElement = elements[paymentIndex === 0 ? 1 : 0]!

  // --- C3. The PAYMENT txn (buyer's axfer) — signed, bound to the trusted accept ---
  if (!payElement.signed) {
    return fail('signature_invalid', 'The payment transaction is not signed by the buyer.')
  }
  const pay = payElement.txn
  if (pay.type !== 'axfer' || !pay.assetTransfer) {
    return fail('transfer_not_found', 'The payment transaction is not an ASA asset-transfer (axfer).')
  }
  const at = pay.assetTransfer
  if (BigInt(at.assetIndex) !== BigInt(assetId)) {
    return fail('transfer_not_found', `Transfer asset id ${at.assetIndex} ≠ rail asset ${assetId}.`)
  }
  if (!addrEq(at.receiver, accept.payTo)) {
    return fail('wrong_recipient', `Transfer pays ${at.receiver?.toString()}, not payTo ${accept.payTo}.`)
  }
  if (BigInt(at.amount) < BigInt(accept.amount)) {
    return fail('amount_too_low', `Transfer pays ${at.amount} of the ASA, required ${accept.amount}.`)
  }
  // Anti-drain: an asset/account close would sweep the buyer's balance to a third party atomically.
  if (isSet(at.closeRemainderTo)) return fail('signature_invalid', 'The payment transaction has an asset-close — refused.')
  if (isSet(pay.rekeyTo)) return fail('signature_invalid', 'The payment transaction has a rekey — refused.')

  // --- C4. The FEE txn — unsigned (the gate signs it), benign, sent BY the trusted fee payer ---
  if (feeElement.signed) {
    return fail('signature_invalid', 'The fee transaction must be left UNSIGNED for the sponsor to sign.')
  }
  const fee = feeElement.txn
  if (fee.type !== 'pay' || !fee.payment) {
    return fail('signature_invalid', 'The fee transaction must be a payment (pay) transaction.')
  }
  if (!addrEq(fee.sender, railFeePayer)) {
    return fail('signature_invalid', `The fee transaction sender ${fee.sender?.toString()} is not the rail fee payer ${railFeePayer}.`)
  }
  if (BigInt(fee.payment.amount) !== 0n) {
    return fail('signature_invalid', 'The fee transaction must move 0 ALGO (it only pools the group fee).')
  }
  // Anti-drain: bound the pooled fee the SPONSOR pays. The gate co-signs + submits this txn, and the
  // fee is debited from its OWN sender (the gate's relayer / the keyless facilitator). Without a cap a
  // malicious buyer could set an arbitrarily large fee and drain the sponsor (confirmed exploitable).
  // The honest path is minFee × GROUP_SIZE (~2000 µALGO); reject anything above MAX_GROUP_FEE.
  const feeAmount = fee.fee != null ? BigInt(fee.fee) : 0n
  if (feeAmount > MAX_GROUP_FEE) {
    return fail('signature_invalid', `The fee transaction fee ${feeAmount} µALGO exceeds the ${MAX_GROUP_FEE} cap (fee-payer drain guard).`)
  }
  if (isSet(fee.payment.closeRemainderTo)) return fail('signature_invalid', 'The fee transaction has an account-close — refused.')
  if (isSet(fee.rekeyTo)) return fail('signature_invalid', 'The fee transaction has a rekey — refused.')

  // --- C5. Group binding — both txns must carry the SAME non-empty group id (the buyer signed
  //     the pairing). The chain re-checks group-id CORRECTNESS atomically at simulate/submit, so
  //     a substituted sibling (different group id) can never settle. ---
  const payGid = pay.group
  const feeGid = fee.group
  if (!payGid || !feeGid || payGid.length === 0) {
    return fail('signature_invalid', 'The transactions are not part of an atomic group.')
  }
  if (Buffer.from(payGid).toString('hex') !== Buffer.from(feeGid).toString('hex')) {
    return fail('signature_invalid', 'The payment and fee transactions belong to different groups.')
  }

  // --- C6. Co-sign the fee txn as the fee payer, reassemble the group in ORIGINAL order ---
  let feeSigned: Uint8Array
  try {
    feeSigned = fee.signTxn(feePayerSk)
  } catch (err) {
    throw new SettlementError(`Algorand exact settle: the gate could not sign the fee transaction (${shorten(err instanceof Error ? err.message : String(err))}).`, { cause: err })
  }
  const signedGroup = elements.map((el, i) => (i === paymentIndex ? payElement.raw : feeSigned))

  // --- C7. Simulate BEFORE submit — verifies BOTH signatures (a forged buyer sig → signature_invalid)
  //     and catches an expired validity window / would-revert, costing nothing. A transient sim RPC
  //     failure does NOT block (submit re-validates). ---
  try {
    const sim = await client.simulate(signedGroup)
    if (sim.failureMessage) {
      const m = sim.failureMessage
      if (/signature|sig|auth/i.test(m)) return fail('signature_invalid', `Signature verification failed: ${shorten(m)}.`)
      // `validity`/`dead`/`round` — NOT bare `valid` (which also matches "invalid …" would-revert msgs).
      if (/\bround\b|expired|lifetime|validity|dead/i.test(m)) return fail('payment_expired', `Transaction validity window is no longer valid: ${shorten(m)}.`)
      if (/overspend|below min|underflow|insufficient|asset|frozen|opt|missing/i.test(m)) return fail('tx_reverted', `Group would fail on-chain: ${shorten(m)}.`)
      return fail('tx_reverted', `Group would fail on-chain: ${shorten(m)}.`)
    }
  } catch {
    // Transient simulate failure — don't block; submit re-validates everything below.
  }

  // --- C8. SUBMIT (settle). A failure of a VALID group is SERVER-side → SettlementError (gate 5xx),
  //     EXCEPT a client-fixable cause (bad sig / expired) surfaced in the submit error. ---
  const buyerTxid = pay.txID()
  try {
    await client.submit(signedGroup)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    if (/signature|sig|auth|malformed/i.test(m)) return fail('signature_invalid', `Settle rejected — bad signature: ${shorten(m)}.`)
    // Check "already in ledger" BEFORE expiry, and match `validity` not bare `valid` (avoids "invalid").
    if (/already in ledger|already committed|duplicate/i.test(m)) return fail('tx_already_used', `This payment was already settled: ${shorten(m)}.`)
    if (/\bround\b|expired|lifetime|stale|validity/i.test(m)) return fail('payment_expired', `Settle rejected — validity window expired: ${shorten(m)}.`)
    throw new SettlementError(
      `Algorand exact settle: the group failed to submit (${shorten(m)}). The buyer's signed transaction is still ` +
        `valid — fund/fix the fee payer (${railFeePayer}) and the buyer can re-present it.`,
      { cause: err }
    )
  }

  // --- C9. Confirm (single-step finality, ~3s). A timeout is server-side (likely landed) → throw. ---
  let round: number | null
  try {
    round = await client.waitForConfirmation(buyerTxid)
  } catch (err) {
    throw new SettlementError(`Algorand exact settle: submitted ${buyerTxid} but confirmation read failed (${shorten(err instanceof Error ? err.message : String(err))}). It likely landed — re-verify before re-presenting; do NOT re-pay.`, { cause: err })
  }
  if (round === null) {
    throw new SettlementError(`Algorand exact settle: submitted ${buyerTxid} but it did not confirm in time. It likely landed — re-verify before re-presenting; do NOT re-pay.`)
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: buyerTxid,
      asset: accept.asset,
      amount: accept.amount,
      payer: pay.sender.toString(),
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
