/**
 * ── XRPL SECTION: verify ──
 * Local, RPC-only verification of an XRP Ledger payment. Template A (memo-bound):
 * read recent transactions for the MERCHANT account — re-derived from the
 * trusted `accept.payTo`, never the client ref — find the validated Payment that
 * carries our challenge nonce in a Memo, then confirm it succeeded, is recent,
 * and actually delivered ≥ the required amount of the right asset.
 *
 * Because the nonce is committed inside the signed tx (the Memo) and re-checked
 * here, a stranger's payment can't satisfy a different challenge — the same
 * cryptographic binding the TON / Stellar drivers use. Holds the payment to the
 * EVM/Solana verifiers' bar: exists, validated, recent, right amount/asset.
 *
 * **Partial-payment guard (security-critical).** A successful (tesSUCCESS) XRPL
 * Payment using tfPartialPayment can show a large `Amount` but DELIVER almost
 * nothing — XRPL docs warn this is used to steal from naive integrations. So we
 * compare against `delivered_amount` (what actually arrived), never `Amount`.
 *
 * The reads are injected behind a tiny `XrplReader` so this is unit-testable
 * with a mock (like the TON / Stellar verifiers).
 */
import { parseXrplAssetId } from './chains.js'
import { nonceToMemoHex } from './pay.js'
import { floorUnits } from '../../util/units.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** A delivered amount as XRPL returns it: drops string (XRP) or an IOU object. */
export type XrplDeliveredAmount =
  | string
  | { currency: string; issuer: string; value: string }

/** A transaction as the verifier needs it (adapted from account_tx in index.ts). */
export interface XrplTxRecord {
  hash: string
  /** Final, irreversible. account_tx with validated ledgers returns true. */
  validated: boolean
  /** meta.TransactionResult, e.g. 'tesSUCCESS'. */
  result: string
  TransactionType: string
  /** The payer (tx Account). */
  Account: string
  Destination?: string
  Memos?: { Memo?: { MemoData?: string } }[]
  /** meta.delivered_amount — what ACTUALLY arrived (partial-payment safe). */
  delivered_amount?: XrplDeliveredAmount
  /** Tx close time in the Ripple epoch (seconds since 2000-01-01Z). */
  date?: number
}

/** The single read the verifier needs — adapted from a live node in index.ts. */
export interface XrplReader {
  /** Recent transactions affecting `account`, newest first. */
  transactionsForAccount(account: string, limit: number): Promise<XrplTxRecord[]>
}

export interface VerifyXrplParams {
  reader: XrplReader
  accept: X402AcceptEntry
}

/** Ripple epoch (2000-01-01Z) → Unix epoch offset, in seconds. */
const RIPPLE_EPOCH_OFFSET = 946684800

export async function verifyXrpl(params: VerifyXrplParams): Promise<VerifyResult> {
  const { reader, accept } = params
  const required = BigInt(accept.amount)
  const nonce = accept.extra.nonce
  const wantMemo = nonceToMemoHex(nonce)
  const wantAsset = parseXrplAssetId(accept.asset) // null => native XRP

  let txs: XrplTxRecord[]
  try {
    txs = await reader.transactionsForAccount(accept.payTo, 50)
  } catch {
    return rpcFailed(nonce)
  }

  // Bind to THIS challenge: the Payment to payTo whose Memo carries our nonce.
  const tx = txs.find(
    (t) =>
      t.TransactionType === 'Payment' &&
      t.Destination === accept.payTo &&
      hasNonceMemo(t.Memos, wantMemo)
  )
  if (!tx) return notFound(nonce)

  if (!tx.validated) {
    return {
      ok: false,
      error: 'insufficient_confirmations',
      detail: `XRPL tx ${tx.hash} for nonce ${nonce} is not yet validated — retry.`,
    }
  }
  if (tx.result !== 'tesSUCCESS') {
    return {
      ok: false,
      error: 'tx_reverted',
      detail: `XRPL tx ${tx.hash} for nonce ${nonce} failed on-ledger (${tx.result}).`,
    }
  }

  if (typeof tx.date === 'number') {
    const ageSeconds = Math.floor(Date.now() / 1000) - (tx.date + RIPPLE_EPOCH_OFFSET)
    if (ageSeconds > accept.maxTimeoutSeconds) {
      return {
        ok: false,
        error: 'payment_expired',
        detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
      }
    }
  }

  // Partial-payment guard: compare what was DELIVERED, in the right asset.
  const paid = deliveredBaseUnits(tx.delivered_amount, wantAsset, accept.extra.decimals)
  if (paid === null) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail:
        `XRPL tx ${tx.hash} carries our nonce but delivered no matching ` +
        `${wantAsset ? 'IOU' : 'XRP'} to ${accept.payTo} (wrong asset, or delivered_amount unavailable).`,
    }
  }
  if (paid < required) {
    return {
      ok: false,
      error: 'amount_too_low',
      detail: `Delivered ${paid}, required ${required}.`,
    }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: tx.hash,
      asset: accept.asset,
      amount: accept.amount,
      payer: tx.Account,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/** True if any Memo's MemoData equals the nonce hex (case-insensitive). */
function hasNonceMemo(
  memos: { Memo?: { MemoData?: string } }[] | undefined,
  wantMemo: string
): boolean {
  if (!memos) return false
  return memos.some((m) => (m.Memo?.MemoData ?? '').toUpperCase() === wantMemo)
}

/**
 * Convert a delivered_amount to base units IF it matches the required asset,
 * else null. Native XRP arrives as a drops string (integer base units); an IOU
 * arrives as { currency, issuer, value } (a decimal string → floor to decimals).
 */
function deliveredBaseUnits(
  delivered: XrplDeliveredAmount | undefined,
  want: { currencyHex: string; issuer: string } | null,
  decimals: number
): bigint | null {
  if (delivered === undefined) return null

  if (want === null) {
    // Native XRP: delivered must be a drops string, not an IOU object.
    if (typeof delivered !== 'string') return null
    if (!/^\d+$/.test(delivered)) return null
    return BigInt(delivered)
  }

  // Issued currency: delivered must be the matching IOU object.
  if (typeof delivered === 'string') return null
  if (
    delivered.currency.toUpperCase() !== want.currencyHex.toUpperCase() ||
    delivered.issuer !== want.issuer
  ) {
    return null
  }
  try {
    return floorUnits(delivered.value, decimals)
  } catch {
    return null
  }
}

function notFound(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'transfer_not_found',
    detail:
      `No matching XRPL payment found for nonce ${nonce} ` +
      `(not yet validated, or wrong recipient/amount/asset/memo).`,
  }
}

/** A transient RPC read failure — not a definitive "no transfer" (ERRORS.md §5). */
function rpcFailed(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Could not read XRPL for nonce ${nonce} (transient RPC failure) — retry.`,
  }
}
