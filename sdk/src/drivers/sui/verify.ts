/**
 * ── SUI SECTION: verify ──
 * Local, RPC-only verification of a Sui payment. Template B (digest-bound, like
 * EVM/Solana): the proof ref is the tx digest; binding comes from a single-use
 * proof (the gate's used-set) + recipient + amount + coinType + recency.
 *
 * `balanceChanges` is the cleanest primitive — no per-coin event parsing: a
 * successful tx exposes a positive change of the required coin type to `payTo`.
 * The watched recipient (`accept.payTo`) and coin type come from the TRUSTED
 * accept, never the client ref.
 *
 * No memo binds the tx to THIS challenge beyond amount/recipient, so — per the
 * "Five Attacks on x402" note (README §3a) — persistent isUsed/markUsed +  a tight
 * maxTimeoutSeconds are load-bearing on digest-bound chains (same as EVM/Solana).
 *
 * The reads are injected behind a tiny `SuiReader` so this is unit-testable.
 */
import { SUI_NATIVE_COINTYPE } from './chains.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** A normalised balance change (owner pre-extracted to a plain address). */
export interface SuiBalanceChange {
  /** The AddressOwner, or '' if the change isn't owned by a plain address. */
  owner: string
  coinType: string
  /** Signed integer base units; positive = received, negative = spent. */
  amount: string
}

/** A transaction view the verifier needs (adapted from getTransactionBlock in index.ts). */
export interface SuiTxView {
  /** Execution status: 'success' | 'failure'. */
  status: string
  /** Checkpoint timestamp (ms). */
  timestampMs?: number
  balanceChanges: SuiBalanceChange[]
}

export interface SuiReader {
  /** Fetch a tx by digest with balance changes + effects; null if unknown. */
  getTransaction(digest: string): Promise<SuiTxView | null>
}

export interface VerifySuiParams {
  reader: SuiReader
  /** The proof digest. */
  digest: string
  accept: X402AcceptEntry
}

export async function verifySui(params: VerifySuiParams): Promise<VerifyResult> {
  const { reader, digest, accept } = params
  const required = BigInt(accept.amount)
  const wantCoinType = accept.asset === 'native' ? SUI_NATIVE_COINTYPE : accept.asset

  let tx: SuiTxView | null
  try {
    tx = await reader.getTransaction(digest)
  } catch {
    return txNotFound(digest)
  }
  if (!tx) return txNotFound(digest)

  if (tx.status !== 'success') {
    return { ok: false, error: 'tx_reverted', detail: `Sui tx ${digest} did not succeed (status=${tx.status}).` }
  }

  // Recency (replay window). A missing/unreadable timestamp means we can't BOUND the age — fail
  // CLOSED (reject), never open, exactly like the Solana/NEAR drivers. confirm() awaits finalization
  // before verify, so a legit tx always carries a checkpoint timestamp by this point.
  // Number.isFinite (not `typeof === 'number'`): NaN/Infinity are typeof 'number' and would make
  // ageSeconds NaN, which slips past the `> max` check (NaN comparisons are false) → fail OPEN. The
  // Sui JSON-RPC returns timestampMs as a string the adapter Number()s, so a malformed RPC value
  // could yield NaN/Infinity — reject it here, fail CLOSED.
  if (!Number.isFinite(tx.timestampMs)) {
    return { ok: false, error: 'payment_expired', detail: `Cannot determine the age of ${digest} (no/invalid timestampMs) — fail closed.` }
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor((tx.timestampMs as number) / 1000)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  // Sum positive balance changes of the required coin type credited to payTo;
  // capture the spender (a negative change) as the payer. Recipient is compared in CANONICAL
  // Sui form on BOTH sides: the RPC returns `bc.owner` lowercase/zero-padded, but the merchant's
  // `accept.payTo` can be mixed/upper-case (copied from an explorer) — and the funds still arrive
  // (the payer's tx serializes to canonical bytes). Without normalizing, a mixed-case payTo would
  // be paid on-chain yet verify forever as transfer_not_found (mirrors EVM's getAddress() on both
  // sides).
  const want = normalizeSuiAddress(accept.payTo)
  let paid = 0n
  let payer = ''
  for (const bc of tx.balanceChanges) {
    if (bc.coinType !== wantCoinType) continue
    let v: bigint
    try {
      v = BigInt(bc.amount)
    } catch {
      continue
    }
    if (bc.owner && normalizeSuiAddress(bc.owner) === want && v > 0n) paid += v
    else if (v < 0n && !payer) payer = bc.owner ? normalizeSuiAddress(bc.owner) : bc.owner
  }

  if (paid < required) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail: `No Sui transfer of >= ${required} (${wantCoinType}) to ${accept.payTo} in ${digest}.`,
    }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: digest,
      asset: accept.asset,
      amount: accept.amount,
      payer,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/** Transient: not found / not yet propagated, or the RPC read failed (ERRORS.md §5). */
function txNotFound(digest: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Sui tx ${digest} not found or not yet propagated — retry.`,
  }
}

/**
 * Canonical Sui address form: `0x` + 64 lowercase hex chars (zero-padded) — the same shape the
 * RPC emits for `balanceChanges[].owner`. A merchant's `payTo` may be mixed/upper-case or short;
 * this folds both sides to one form so the recipient match is case- and padding-insensitive (the
 * equivalent of viem's `getAddress` on EVM). A non-hex string is returned lowercased, never a
 * throw — `verify()` must not throw. (Kept local + pure so this module stays unit-testable without
 * the `@mysten/sui` runtime; matches `normalizeSuiAddress` from `@mysten/sui/utils`.)
 */
function normalizeSuiAddress(value: string): string {
  const lower = value.toLowerCase()
  const hex = lower.replace(/^0x/, '')
  if (hex.length === 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) return lower
  return `0x${hex.padStart(64, '0')}`
}
