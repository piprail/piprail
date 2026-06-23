/**
 * ── SOLANA SECTION: verify ──
 * Local, RPC-only verification of a Solana payment from its signature.
 * Mirrors the EVM verifier's checks: exists & succeeded, recent (replay
 * window), and actually moved `amount` of the asset to `payTo`.
 *
 * Recipient + amount are proven from the transaction's own balance deltas
 * (`pre/postTokenBalances` for SPL, `pre/postBalances` for SOL) — the same
 * way Solana Pay's `validateTransfer` does, which is robust against however
 * the transfer was constructed. `connection` is injected so it's testable
 * with a mock.
 */
import type { Connection } from '@solana/web3.js'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

export interface VerifySolanaParams {
  connection: Pick<Connection, 'getParsedTransaction'>
  signature: string
  accept: X402AcceptEntry
}

export async function verifySolana(
  params: VerifySolanaParams
): Promise<VerifyResult> {
  const { connection, signature, accept } = params
  const required = BigInt(accept.amount)

  let tx
  try {
    tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
  } catch {
    return notFound(signature)
  }
  if (!tx) return notFound(signature)

  const meta = tx.meta
  if (!meta) {
    return { ok: false, error: 'no_meta', detail: `No metadata for ${signature}.` }
  }
  if (meta.err !== null) {
    return {
      ok: false,
      error: 'tx_reverted',
      detail: `Transaction ${signature} failed on-chain.`,
    }
  }

  // Replay window: reject ancient payments to the same address. A missing/non-finite blockTime
  // means we can't bound the age — fail closed rather than open. Number.isFinite (not
  // `typeof === 'number'`) also rejects NaN/Infinity, which would make ageSeconds NaN and slip past
  // the `> max` check (NaN comparisons are false) → fail open.
  if (!Number.isFinite(tx.blockTime)) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Cannot determine the age of ${signature} (no/invalid blockTime).`,
    }
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - (tx.blockTime as number)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    k.pubkey.toBase58()
  )
  const payer = accountKeys[0] ?? '' // fee payer

  if (accept.asset === 'native') {
    const idx = accountKeys.indexOf(accept.payTo)
    if (idx < 0) {
      return {
        ok: false,
        error: 'wrong_recipient',
        detail: `Native payment in ${signature} did not credit ${accept.payTo}.`,
      }
    }
    const delta =
      BigInt(meta.postBalances[idx] ?? 0) - BigInt(meta.preBalances[idx] ?? 0)
    if (delta < required) {
      return {
        ok: false,
        error: 'amount_too_low',
        detail: `Credited ${delta} lamports, required ${required}.`,
      }
    }
  } else {
    const mint = accept.asset
    const pre = meta.preTokenBalances ?? []
    const post = meta.postTokenBalances ?? []
    let delta = 0n
    for (const p of post) {
      if (p.mint !== mint || p.owner !== accept.payTo) continue
      const before = pre.find((x) => x.accountIndex === p.accountIndex)
      delta +=
        BigInt(p.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0')
    }
    if (delta < required) {
      return {
        ok: false,
        error: 'transfer_not_found',
        detail: `No SPL transfer of >= ${required} (mint ${mint}) to ${accept.payTo} in ${signature}.`,
      }
    }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: signature,
      asset: accept.asset,
      amount: accept.amount,
      payer,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

function notFound(signature: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Signature ${signature} not found or not yet confirmed.`,
  }
}
