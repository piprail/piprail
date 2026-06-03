/**
 * ── XRPL SECTION: pay ──
 * Build, sign, and submit an XRP Ledger payment, returning the tx hash.
 *   - native XRP   → Payment with Amount = drops string (integer base units)
 *   - issued (IOU) → Payment with Amount = { currency, issuer, value } where
 *                    value is the human-decimal string (USDC/RLUSD)
 *
 * The challenge nonce is bound TWO ways (Template A, memo-bound):
 *   - a **Memo** carrying the full nonce as hex — the cryptographic binding
 *     verify() matches on (XRPL Memos have no length limit, so the whole nonce
 *     fits; no hashing needed, and it can't collide).
 *   - a **DestinationTag** derived from the nonce (a 32-bit routing tag) — XRPL's
 *     wallet-native field, set so the payment is deliverable even to a merchant
 *     account with requireDestinationTag (the RLUSD issuer sets it). It is NOT
 *     the binding (32 bits can collide); the Memo is.
 *
 * XRPL issued amounts are human-decimal STRINGS, so we send
 * `accept.extra.amountFormatted` directly (already validated to ≤ decimals dp at
 * challenge time) instead of re-scaling base units through the EVM path. Native
 * XRP is integer drops, so `accept.amount` (base units) goes verbatim.
 *
 * Network I/O is injected behind a narrow `XrplPayClient` (raw JSON-RPC, no
 * persistent WebSocket — browser/edge-friendly), so this is unit-testable with a
 * mock. Signing is offline via the xrpl.js Wallet. send() returns the hash;
 * confirm() (in index.ts) waits for validation.
 */
import type { Wallet } from 'xrpl'
import { parseXrplAssetId } from './chains.js'
import {
  InsufficientFundsError,
  RecipientNotReadyError,
  toInsufficientFundsError,
} from '../../errors.js'
import type { X402AcceptEntry } from '../../x402.js'

/** The XRPL JSON-RPC reads/writes pay needs — adapted from a live node in index.ts. */
export interface XrplPayClient {
  /** account_info → account_data.Sequence for `account`. */
  accountSequence(account: string): Promise<number>
  /** fee → drops.open_ledger_fee (a drops string). */
  feeDrops(): Promise<string>
  /** ledger_current → ledger_current_index. */
  currentLedgerIndex(): Promise<number>
  /** submit a signed tx_blob → the preliminary engine result + tx hash. */
  submit(txBlob: string): Promise<{
    engine_result: string
    engine_result_message?: string
    tx_json?: { hash?: string }
  }>
}

export interface PayXrplParams {
  client: XrplPayClient
  wallet: Wallet
  accept: X402AcceptEntry
}

/** The full challenge nonce as an UPPERCASE hex MemoData — the binding. */
export function nonceToMemoHex(nonce: string): string {
  return Buffer.from(nonce, 'utf8').toString('hex').toUpperCase()
}

/**
 * A deterministic non-zero uint32 DestinationTag from the nonce (FNV-1a-32).
 * Routing/deliverability only — the Memo is the cryptographic binding, so a
 * 32-bit collision here is harmless. Pure + sync, no crypto dependency.
 */
export function nonceToDestinationTag(nonce: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < nonce.length; i += 1) {
    h ^= nonce.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const tag = h >>> 0 // to uint32
  return tag === 0 ? 1 : tag
}

export async function payXrpl(params: PayXrplParams): Promise<string> {
  const { client, wallet, accept } = params
  try {
    const [sequence, feeDrops, ledgerIndex] = await Promise.all([
      client.accountSequence(wallet.classicAddress),
      client.feeDrops(),
      client.currentLedgerIndex(),
    ])

    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: wallet.classicAddress,
      Destination: accept.payTo,
      DestinationTag: nonceToDestinationTag(accept.extra.nonce),
      Amount: amountForAccept(accept),
      Memos: [{ Memo: { MemoData: nonceToMemoHex(accept.extra.nonce) } }],
      Sequence: sequence,
      Fee: feeForSubmit(feeDrops),
      LastLedgerSequence: ledgerIndex + 20,
      Flags: 0, // NOT tfPartialPayment — require full delivery
    }

    const signed = wallet.sign(tx as never)
    const res = await client.submit(signed.tx_blob)
    const code = res.engine_result

    // Provisionally applied (tes*) → return the hash; confirm() awaits validation.
    if (code.startsWith('tes')) return res.tx_json?.hash ?? signed.hash

    // Recipient-side setup → RecipientNotReadyError (fix the DESTINATION, not the payer).
    const recipientMsg = recipientNotReadyMessage(code)
    if (recipientMsg) throw new RecipientNotReadyError(recipientMsg, { cause: makeEngineError(res) })

    // Sender affordability → the SAME typed error as every other chain.
    if (isAffordabilityCode(code)) {
      throw new InsufficientFundsError(
        `XRPL payment rejected: the sender can't cover it — balance or the 1 XRP base reserve. (XRPL: ${code})`,
        { cause: makeEngineError(res) }
      )
    }
    // Any other definitive rejection — surface the engine result (don't swallow).
    throw makeEngineError(res)
  } catch (err) {
    // Typed errors we already raised pass through untouched.
    if (err instanceof InsufficientFundsError || err instanceof RecipientNotReadyError) throw err
    // Message-level backstop so affordability surfaces uniformly across chains.
    throw toInsufficientFundsError(err) ?? err
  }
}

/** Turn the wire asset id ('native' | 'currencyHex:issuer') into an XRPL Amount. */
export function amountForAccept(
  accept: X402AcceptEntry
): string | { currency: string; issuer: string; value: string } {
  if (accept.asset === 'native') return accept.amount // drops (integer base units)
  const parts = parseXrplAssetId(accept.asset)
  if (!parts) throw new Error(`XRPL: malformed asset id "${accept.asset}".`)
  return {
    currency: parts.currencyHex,
    issuer: parts.issuer,
    value: accept.extra.amountFormatted,
  }
}

/** Use at least the standard 12-drop fee; honour a higher open-ledger fee. */
function feeForSubmit(openLedgerFee: string): string {
  const fee = Number(openLedgerFee)
  return String(Number.isFinite(fee) && fee > 12 ? Math.ceil(fee) : 12)
}

/** Preserve the raw engine result (code + message) as an Error for `.cause`. */
function makeEngineError(res: { engine_result: string; engine_result_message?: string }): Error {
  return new Error(
    `XRPL engine result ${res.engine_result}${res.engine_result_message ? ` — ${res.engine_result_message}` : ''}`
  )
}

/**
 * XRPL engine result codes where the DESTINATION isn't set up to receive →
 * `RecipientNotReadyError`. Returns the actionable message (with the raw code) or
 * null if `code` isn't recipient-side. `tecNO_DST*` = the payTo account doesn't
 * exist (an account needs ≥1 XRP base reserve to exist); `tecNO_LINE*`/`tecPATH_DRY`
 * = the destination has no trustline for this IOU (or can't afford the reserve to
 * add one); `tecDST_TAG_NEEDED` = it requires a DestinationTag; `tecNO_AUTH`/
 * `tecNO_PERMISSION` = it isn't authorized to hold the asset.
 */
function recipientNotReadyMessage(code: string): string | null {
  if (/^tecNO_DST/.test(code))
    return `XRPL destination isn't activated — an account must hold ≥1 XRP (the base reserve) to exist. Fund the destination with ≥1 XRP before it can receive. (XRPL: ${code})`
  if (/^tecNO_LINE/.test(code) || code === 'tecPATH_DRY')
    return `XRPL destination can't receive this currency — it needs a trustline for it (and the reserve to hold one). (XRPL: ${code})`
  if (code === 'tecDST_TAG_NEEDED')
    return `XRPL destination requires a DestinationTag to receive. (XRPL: ${code})`
  if (/^(tecNO_AUTH|tecNO_PERMISSION)/.test(code))
    return `XRPL destination isn't authorized to hold this asset. (XRPL: ${code})`
  return null
}

/** XRPL engine result codes that mean "the SENDER can't afford it". */
function isAffordabilityCode(code: string): boolean {
  return /^(tecUNFUNDED|tecINSUFF|terINSUF)/.test(code)
}
