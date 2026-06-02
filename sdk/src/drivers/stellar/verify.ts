/**
 * ── STELLAR SECTION: verify ──
 * Local, RPC-only verification of a Stellar payment. Template A (memo-bound):
 * read recent transactions for the MERCHANT account — re-derived from the
 * trusted `accept.payTo`, never the client ref — find the one whose MEMO_HASH
 * equals sha256(nonce), then confirm it succeeded, is recent, and carries a
 * payment op to `payTo` of ≥ the required amount in the right asset.
 *
 * Because the nonce is committed inside the signed tx (the memo) and re-checked
 * here, a stranger's payment can't satisfy a different challenge — the same
 * cryptographic binding the TON / XRPL / NEAR drivers use. Holds the payment to
 * the EVM/Solana verifiers' bar: exists, succeeded, recent, right amount/asset.
 *
 * The Horizon reads are injected behind a tiny `StellarReader` so this is
 * unit-testable with a mock (like the TON verifier's injected client).
 */
import { hash } from '@stellar/stellar-sdk'
import { parseStellarAssetId } from './chains.js'
import { parseUnits } from '../../util/units.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** A transaction as Horizon returns it (only the fields we read). */
export interface StellarTxRecord {
  hash: string
  successful: boolean
  /** Memo value; for MEMO_HASH this is base64 (Horizon) of the 32 bytes. */
  memo?: string
  memo_type: string
  /** ISO-8601 timestamp. */
  created_at: string
}

/** A payment operation as Horizon returns it (only the fields we read). */
export interface StellarPaymentRecord {
  type: string
  from: string
  to: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  /** Human-decimal string, e.g. "0.0500000". */
  amount: string
}

/** The two Horizon reads the verifier needs — adapted from a real Horizon.Server in index.ts. */
export interface StellarReader {
  /** Recent transactions affecting `account`, newest first (failed included). */
  transactionsForAccount(account: string, limit: number): Promise<StellarTxRecord[]>
  /** Payment operations within a transaction. */
  paymentsForTransaction(txHash: string): Promise<StellarPaymentRecord[]>
}

export interface VerifyStellarParams {
  reader: StellarReader
  accept: X402AcceptEntry
}

/**
 * The memo value(s) a MEMO_HASH of `sha256(nonce)` can appear as on Horizon.
 * Horizon encodes hash memos as base64; we also accept hex defensively.
 */
export function memoCandidatesForNonce(nonce: string): string[] {
  const h = Buffer.from(hash(Buffer.from(nonce, 'utf8')))
  return [h.toString('base64'), h.toString('hex')]
}

export async function verifyStellar(params: VerifyStellarParams): Promise<VerifyResult> {
  const { reader, accept } = params
  const nonce = accept.extra.nonce
  const required = BigInt(accept.amount)
  const wantMemo = memoCandidatesForNonce(nonce)
  const wantAsset = parseStellarAssetId(accept.asset) // null => native XLM

  let txs: StellarTxRecord[]
  try {
    txs = await reader.transactionsForAccount(accept.payTo, 50)
  } catch {
    return rpcFailed(nonce)
  }

  // Bind to THIS challenge: the tx whose MEMO_HASH == sha256(nonce).
  const tx = txs.find(
    (t) => t.memo_type === 'hash' && typeof t.memo === 'string' && wantMemo.includes(t.memo)
  )
  if (!tx) return notFound(nonce)

  if (!tx.successful) {
    return {
      ok: false,
      error: 'tx_reverted',
      detail: `Stellar tx ${tx.hash} for nonce ${nonce} failed on-chain.`,
    }
  }

  const ageSeconds =
    Math.floor(Date.now() / 1000) - Math.floor(Date.parse(tx.created_at) / 1000)
  if (Number.isFinite(ageSeconds) && ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  // The memo bound the tx to our challenge; confirm it actually paid us.
  let payments: StellarPaymentRecord[]
  try {
    payments = await reader.paymentsForTransaction(tx.hash)
  } catch {
    return rpcFailed(nonce)
  }

  const toUs = payments.filter(
    (p) => p.type === 'payment' && p.to === accept.payTo && assetMatches(p, wantAsset)
  )
  if (toUs.length === 0) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail:
        `Stellar tx ${tx.hash} carries our nonce but has no matching ` +
        `${wantAsset ? wantAsset.code : 'XLM'} payment to ${accept.payTo}.`,
    }
  }

  // A tx can hold several payment ops to us — sum them, compare to required.
  const paid = toUs.reduce(
    (sum, p) => sum + parseAmount(p.amount, accept.extra.decimals),
    0n
  )
  if (paid < required) {
    return {
      ok: false,
      error: 'amount_too_low',
      detail: `Paid ${paid}, required ${required}.`,
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
      payer: toUs[0]!.from,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

function assetMatches(
  p: StellarPaymentRecord,
  want: { code: string; issuer: string } | null
): boolean {
  if (want === null) return p.asset_type === 'native'
  return (
    p.asset_type !== 'native' &&
    p.asset_code === want.code &&
    p.asset_issuer === want.issuer
  )
}

/** Stellar amounts are 7dp human strings; convert to base units for comparison. */
function parseAmount(amount: string, decimals: number): bigint {
  try {
    return parseUnits(amount, decimals)
  } catch {
    return 0n
  }
}

function notFound(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'transfer_not_found',
    detail:
      `No matching Stellar payment found for nonce ${nonce} ` +
      `(not yet settled, or wrong recipient/amount/asset/memo).`,
  }
}

/** A transient RPC read failure — not a definitive "no transfer" (ERRORS.md §5). */
function rpcFailed(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Could not read Horizon for nonce ${nonce} (transient RPC failure) — retry.`,
  }
}
