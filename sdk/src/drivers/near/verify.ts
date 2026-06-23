/**
 * ── NEAR SECTION: verify ──
 * Local, RPC-only verification of a NEAR payment. Template A (memo-bound) but
 * verified BY TX HASH (NEAR has no clean account-history RPC): given the proof
 * hash + the payer account, read the tx status with receipts, confirm it
 * succeeded, then scan the NEP-297 `ft_transfer` event logs for a transfer of
 * ≥ the required amount to `payTo` whose `memo` equals our challenge nonce.
 *
 * **Provenance:** only logs emitted by a receipt whose executor is the TRUSTED
 * token contract (`accept.asset`) count — a look-alike contract emitting a fake
 * EVENT_JSON can't satisfy the check. **Binding:** the memo must equal the
 * freshly-issued nonce, so an old payment can't satisfy a new challenge — that
 * (plus the gate's single-use set) is NEAR's anti-replay; we don't add a separate
 * block-time read for recency (it would cost an extra round-trip), though the
 * reader may supply a timestamp opportunistically.
 *
 * The reads are injected behind a tiny `NearReader` so this is unit-testable.
 */
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** One receipt's executor + logs (from the tx outcome). */
export interface NearReceiptView {
  /** The account the receipt executed on — the token contract for a real ft_transfer. */
  executorId: string
  logs: string[]
}

/** A tx outcome view the verifier needs (adapted from viewTransactionStatusWithReceipts). */
export interface NearTxView {
  success: boolean
  receipts: NearReceiptView[]
  /** Optional block time (ms) — recency is checked only if present (REQUIRED for native). */
  timestampMs?: number
  /** The transaction's single receiver account id — used by the native (digest-bound) path. */
  receiverId?: string
  /** Summed `Transfer` action deposits in yoctoNEAR (native path) — base-unit string. */
  nativeDeposit?: string
}

export interface NearReader {
  txStatus(hash: string, senderId: string): Promise<NearTxView | null>
}

export interface VerifyNearParams {
  reader: NearReader
  /** The on-chain tx hash. */
  hash: string
  /** The payer account id (needed to locate the tx). */
  senderId: string
  accept: X402AcceptEntry
}

interface FtTransferData {
  old_owner_id?: string
  new_owner_id?: string
  amount?: string
  memo?: string
}

/** Parse a NEP-297 `EVENT_JSON:` log line into its `ft_transfer` data entries, or null. */
export function parseFtTransferEvent(line: string): FtTransferData[] | null {
  const marker = 'EVENT_JSON:'
  const i = line.indexOf(marker)
  if (i < 0) return null
  try {
    const ev = JSON.parse(line.slice(i + marker.length)) as {
      standard?: string
      event?: string
      data?: FtTransferData[]
    }
    if (ev.standard === 'nep141' && ev.event === 'ft_transfer' && Array.isArray(ev.data)) {
      return ev.data
    }
  } catch {
    /* not JSON — skip */
  }
  return null
}

export async function verifyNear(params: VerifyNearParams): Promise<VerifyResult> {
  const { reader, hash, senderId, accept } = params
  const required = BigInt(accept.amount)
  const nonce = accept.extra.nonce

  let tx: NearTxView | null
  try {
    tx = await reader.txStatus(hash, senderId)
  } catch {
    return txNotFound(hash)
  }
  if (!tx) return txNotFound(hash)

  if (!tx.success) {
    return { ok: false, error: 'tx_reverted', detail: `NEAR tx ${hash} failed on-chain.` }
  }

  // Native NEAR (digest-bound, like EVM/Solana/Sui): there's no on-chain nonce, so prove the
  // tx moved >= amount native NEAR to payTo AND is RECENT. Recency is load-bearing here
  // (a memo can't bind a bare Transfer); the gate's single-use set covers reuse. We fail
  // CLOSED if the block time is unavailable rather than accept an un-bounded-age payment.
  if (accept.asset === 'native') {
    // Number.isFinite (not `typeof === 'number'`): NaN/Infinity are typeof 'number' and would make
    // ageSeconds NaN, which slips past the `> max` check → fail open. Reject them — fail CLOSED.
    if (!Number.isFinite(tx.timestampMs)) {
      return { ok: false, error: 'payment_expired', detail: `Cannot bound the age of native NEAR tx ${hash} (no/invalid block time) — failing closed.` }
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor((tx.timestampMs as number) / 1000)
    if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
      return { ok: false, error: 'payment_expired', detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.` }
    }
    if (tx.receiverId !== accept.payTo) {
      return { ok: false, error: 'transfer_not_found', detail: `Native NEAR tx ${hash} did not pay ${accept.payTo} (receiver ${tx.receiverId ?? 'unknown'}).` }
    }
    let paid: bigint
    try { paid = BigInt(tx.nativeDeposit ?? '0') } catch { paid = 0n }
    if (paid < required) {
      return { ok: false, error: 'amount_too_low', detail: `Native NEAR transfer to ${accept.payTo} was ${paid} yocto, required ${required}.` }
    }
    return {
      ok: true,
      receipt: {
        scheme: 'onchain-proof', success: true, network: accept.network,
        transaction: hash, asset: 'native', amount: accept.amount,
        payer: senderId, payTo: accept.payTo, verifiedAt: new Date().toISOString(),
      },
    }
  }

  if (typeof tx.timestampMs === 'number') {
    const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(tx.timestampMs / 1000)
    if (ageSeconds > accept.maxTimeoutSeconds) {
      return {
        ok: false,
        error: 'payment_expired',
        detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
      }
    }
  }

  // Bind to THIS challenge: an ft_transfer to payTo carrying our nonce in its memo,
  // emitted by the TRUSTED token contract (provenance). Sum matching amounts.
  let paid = 0n
  let payer = ''
  for (const r of tx.receipts) {
    if (r.executorId !== accept.asset) continue
    for (const line of r.logs) {
      const data = parseFtTransferEvent(line)
      if (!data) continue
      for (const d of data) {
        if (d.new_owner_id === accept.payTo && (d.memo ?? '') === nonce) {
          try {
            paid += BigInt(d.amount ?? '0')
          } catch {
            /* malformed amount — skip */
          }
          if (!payer) payer = d.old_owner_id ?? ''
        }
      }
    }
  }

  if (paid < required) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail:
        `No NEP-141 ft_transfer of >= ${required} (token ${accept.asset}) to ${accept.payTo} ` +
        `carrying our nonce in ${hash}.`,
    }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
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

/** Transient: tx not found / not yet executed, or the RPC read failed (ERRORS.md §5). */
function txNotFound(hash: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `NEAR tx ${hash} not found or not yet executed — retry.`,
  }
}
