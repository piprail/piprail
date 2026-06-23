/**
 * ── ALGORAND SECTION: verify ──
 * Local, RPC-only verification of an Algorand payment. Template A (memo-bound):
 * read recent transactions for the MERCHANT account — re-derived from the trusted
 * `accept.payTo`, never the client ref — find the one whose decoded note equals the
 * challenge nonce, then confirm it's recent and carries the right value transfer
 * (native ALGO `pay` or the required ASA `axfer`) to `payTo` of ≥ the required amount.
 *
 * Because the nonce is committed inside the signed tx (the note) and re-checked
 * here, a stranger's payment can't satisfy a different challenge — the same
 * cryptographic binding the TON / Stellar / XRPL / NEAR drivers use, strictly
 * stronger than the digest-only chains. Algorand commits transactions atomically
 * (a failed transfer never lands in a block), so there's no "reverted" state to
 * screen — presence in the indexer means it succeeded.
 *
 * The indexer reads are injected behind a tiny `AlgorandReader` so this is
 * unit-testable with a plain mock (like the Stellar verifier's injected reader).
 */
import { parseAlgorandAssetId } from './chains.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** A transaction as the verifier needs it — normalised from the algosdk indexer model in index.ts. */
export interface AlgorandTxRecord {
  /** The transaction id. */
  id: string
  /** The note field decoded best-effort as UTF-8 (undefined if absent). */
  note?: string
  /** 'pay' (native ALGO) | 'axfer' (ASA) | other. */
  txType: string
  /** Receiver of the value transfer. */
  receiver?: string
  /** Amount delivered, in base units (string). */
  amount?: string
  /** ASA id for an axfer; undefined for a native pay. */
  assetId?: number
  /** Sender (the payer) address. */
  sender?: string
  /** Confirmed-round time, unix SECONDS. */
  roundTime?: number
}

/** The single indexer read the verifier needs — adapted from a real algosdk Indexer in index.ts. */
export interface AlgorandReader {
  /** Recent transactions affecting `account`, newest first. */
  transactionsForAccount(account: string, limit: number): Promise<AlgorandTxRecord[]>
}

export interface VerifyAlgorandParams {
  reader: AlgorandReader
  accept: X402AcceptEntry
}

export async function verifyAlgorand(params: VerifyAlgorandParams): Promise<VerifyResult> {
  const { reader, accept } = params
  const nonce = accept.extra.nonce
  const required = BigInt(accept.amount)
  const wantAssetId = parseAlgorandAssetId(accept.asset) // null => native ALGO

  let txs: AlgorandTxRecord[]
  try {
    txs = await reader.transactionsForAccount(accept.payTo, 50)
  } catch {
    return rpcFailed(nonce)
  }

  // Bind to THIS challenge: the tx whose note == nonce.
  const tx = txs.find((t) => typeof t.note === 'string' && t.note === nonce)
  if (!tx) return notFound(nonce)

  // Recency fails CLOSED, like Solana/NEAR/Stellar/Sui. A missing/non-finite roundTime means we
  // can't BOUND the age — reject, never accept an unbounded-age proof. (roundTime is optional in
  // the indexer model, so an edge-state/degraded RPC can omit it; once the bounded used-proof set
  // evicts a redeemed nonce past the window, this recency check is the only remaining replay guard
  // — it must not fail open. The old `typeof === 'number'` + `&& Number.isFinite` form skipped the
  // whole check when roundTime was absent, and let a NaN slip through.)
  if (!Number.isFinite(tx.roundTime)) {
    return { ok: false, error: 'payment_expired', detail: `Cannot bound the age of Algorand tx ${tx.id} (no/invalid round-time) — failing closed.` }
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - (tx.roundTime as number)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  // The note bound the tx to our challenge; confirm it actually paid us in the right asset.
  const isNative = wantAssetId === null
  const typeOk = isNative ? tx.txType === 'pay' : tx.txType === 'axfer'
  const assetOk = isNative ? tx.assetId == null : tx.assetId === wantAssetId
  if (!typeOk || tx.receiver !== accept.payTo || !assetOk) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail:
        `Algorand tx ${tx.id} carries our nonce but has no matching ` +
        `${isNative ? 'ALGO' : `ASA ${wantAssetId}`} transfer to ${accept.payTo}.`,
    }
  }

  let paid = 0n
  try {
    paid = tx.amount ? BigInt(tx.amount) : 0n
  } catch {
    paid = 0n
  }
  if (paid < required) {
    return { ok: false, error: 'amount_too_low', detail: `Paid ${paid}, required ${required}.` }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: tx.id,
      asset: accept.asset,
      amount: accept.amount,
      payer: tx.sender ?? '',
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

function notFound(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'transfer_not_found',
    detail:
      `No matching Algorand payment found for nonce ${nonce} ` +
      `(not yet settled, or wrong recipient/amount/asset/note).`,
  }
}

/** A transient indexer read failure — not a definitive "no transfer" (ERRORS.md §5). */
function rpcFailed(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Could not read the Algorand indexer for nonce ${nonce} (transient RPC failure) — retry.`,
  }
}
