/**
 * ── APTOS SECTION: verify ──
 * Local, RPC-only verification of an Aptos payment. Template B (digest-bound,
 * like Sui/EVM/Solana): the proof ref is the tx hash; binding comes from a
 * single-use proof (the gate's used-set) + recipient + amount + metadata + recency.
 *
 * Aptos FA transfers emit `0x1::fungible_asset::Deposit { store, amount }` events,
 * where `store` is the RECIPIENT's primary store object (metadata-specific). To
 * confirm the recipient is `payTo`, we re-derive payTo's primary store for the
 * required metadata from the TRUSTED `accept` (via the reader's `primaryStore`,
 * never the client ref) and match deposits against it. Because a primary store
 * address is metadata-specific, matching the store also confirms the asset.
 *
 * No memo binds the tx to THIS challenge beyond amount/recipient, so — per the
 * "Five Attacks on x402" note (README §3a) — persistent isUsed/markUsed + a tight
 * maxTimeoutSeconds are load-bearing on digest-bound chains (same as Sui/EVM).
 *
 * The reads are injected behind a tiny `AptosReader` so this is unit-testable.
 */
import { APT_FA_METADATA } from './chains.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** A normalised FA deposit (store + amount), store pre-normalised to canonical form. */
export interface AptosDeposit {
  /** The recipient's primary store object address (canonical form). */
  store: string
  /** Deposited base units (string). */
  amount: string
}

/** A transaction view the verifier needs (adapted from getTransactionByHash in index.ts). */
export interface AptosTxView {
  /** Did the transaction execute successfully? */
  success: boolean
  /** Block/commit timestamp in SECONDS. */
  timestampSeconds?: number
  /** The transaction sender (the payer), canonical form. */
  sender: string
  /** FA Deposit events, store-normalised. */
  deposits: AptosDeposit[]
}

export interface AptosReader {
  /** Fetch a committed user tx by hash; null if pending/unknown. */
  getTransaction(hash: string): Promise<AptosTxView | null>
  /** Derive the canonical primary-store address for (owner, FA metadata). */
  primaryStore(owner: string, metadata: string): Promise<string>
}

export interface VerifyAptosParams {
  reader: AptosReader
  /** The proof tx hash. */
  hash: string
  accept: X402AcceptEntry
}

export async function verifyAptos(params: VerifyAptosParams): Promise<VerifyResult> {
  const { reader, hash, accept } = params
  const required = BigInt(accept.amount)
  const wantMetadata = accept.asset === 'native' ? APT_FA_METADATA : accept.asset

  let tx: AptosTxView | null
  try {
    tx = await reader.getTransaction(hash)
  } catch {
    return txNotFound(hash)
  }
  if (!tx) return txNotFound(hash)

  if (!tx.success) {
    return { ok: false, error: 'tx_reverted', detail: `Aptos tx ${hash} did not succeed.` }
  }

  // Aptos is digest-bound (Template B): recency is load-bearing, so it fails CLOSED on a
  // missing/non-finite timestamp — matching Solana/Sui/NEAR. Number.isFinite (not typeof) also
  // rejects NaN/Infinity, which would make ageSeconds NaN and slip past the `> max` check.
  if (!Number.isFinite(tx.timestampSeconds)) {
    return { ok: false, error: 'payment_expired', detail: `Cannot bound the age of Aptos tx ${hash} (no/invalid timestamp) — failing closed.` }
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - (tx.timestampSeconds as number)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  // Re-derive payTo's primary store for the required metadata from the trusted
  // accept (a transient RPC failure here is reported as not-found, never thrown).
  let wantStore: string
  try {
    wantStore = await reader.primaryStore(accept.payTo, wantMetadata)
  } catch {
    return txNotFound(hash)
  }

  let paid = 0n
  for (const d of tx.deposits) {
    if (d.store !== wantStore) continue
    try {
      paid += BigInt(d.amount)
    } catch {
      continue
    }
  }

  if (paid < required) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail: `No Aptos transfer of >= ${required} (${wantMetadata}) to ${accept.payTo} in ${hash}.`,
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
      payer: tx.sender,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/** Transient: not found / not yet propagated, or the RPC read failed (ERRORS.md §5). */
function txNotFound(hash: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Aptos tx ${hash} not found or not yet propagated — retry.`,
  }
}
