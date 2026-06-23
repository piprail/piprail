/**
 * ── TRON SECTION: verify ──
 * Local, RPC-only verification of a Tron TRC-20 payment. Digest-bound (Template
 * B, like EVM/Solana): the proof ref is the txid; binding comes from a single-use
 * proof (the gate's used-set) + recipient + amount + asset + recency.
 *
 * Given the txid we read the CONFIRMED transaction info from the SOLIDITY node
 * (the finality gate — an unconfirmed/unknown tx reads as not-found), then
 * confirm it succeeded, is recent, and emitted a TRC-20 `Transfer` of ≥ the
 * required amount of the right token to `payTo`. The Transfer event is identical
 * to ERC-20 (`topic0 = ddf252ad…`), so the decode mirrors the EVM verifier.
 *
 * Addresses in Tron logs are 20-byte hex WITHOUT the 0x41 network byte, so the
 * expected token + payTo are passed in pre-derived to that same 20-byte form
 * (computed in index.ts via tronweb) — keeping this module pure + unit-testable.
 */
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** keccak256("Transfer(address,address,uint256)") — bare hex, as Tron logs carry it. */
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** A confirmed-tx log entry (TronGrid `log[]`). */
export interface TronLog {
  /** Emitting contract, 20-byte hex (no 41 prefix). */
  address: string
  /** [topic0, from, to] — 32-byte hex, no 0x. */
  topics: string[]
  /** ABI-encoded data (the transfer amount), 32-byte hex, no 0x. */
  data: string
}

/** Confirmed transaction info from the solidity node (`gettransactioninfobyid`). */
export interface TronTxInfo {
  id: string
  /** Block height the tx landed in. */
  blockNumber?: number
  /** Block close time, in MILLISECONDS. */
  blockTimeStamp: number
  receipt?: { result?: string }
  log?: TronLog[]
}

/** A raw transaction (`gettransactionbyid`) — the native path reads its TransferContract. */
export interface TronRawTx {
  /** Per-contract result; 'SUCCESS' on a good transfer. */
  ret?: { contractRet?: string }[]
  raw_data?: {
    contract?: {
      type?: string
      parameter?: { value?: { amount?: number; to_address?: string; owner_address?: string } }
    }[]
  }
}

/** The reads the verifier needs — adapted from a live tronweb in index.ts. */
export interface TronReader {
  /** Confirmed receipt + logs (SOLIDITY node). null if not yet confirmed/unknown. */
  getTransactionInfo(txid: string): Promise<TronTxInfo | null>
  /** Raw tx (contracts + per-contract ret) — for the native-TRX path. */
  getTransaction(txid: string): Promise<TronRawTx | null>
}

export interface VerifyTronParams {
  reader: TronReader
  accept: X402AcceptEntry
  /** The proof txid (bare hex). */
  txid: string
  /** TRC-20 contract as 20-byte hex (no 41), lowercase. */
  tokenHex20: string
  /** payTo as 20-byte hex (no 41), lowercase. */
  payToHex20: string
  /** 20-byte hex (no 41) → Base58 T… — for the receipt's payer field. */
  toBase58: (hex20: string) => string
}

export async function verifyTron(params: VerifyTronParams): Promise<VerifyResult> {
  const { reader, accept, txid, tokenHex20, payToHex20, toBase58 } = params
  const required = BigInt(accept.amount)

  let info: TronTxInfo | null
  try {
    info = await reader.getTransactionInfo(txid)
  } catch {
    return txNotFound(txid)
  }
  // No confirmed info → not yet solidified (the finality gate) or unknown. Transient.
  if (!info || !info.id) return txNotFound(txid)

  if (info.receipt?.result !== 'SUCCESS') {
    return {
      ok: false,
      error: 'tx_reverted',
      detail: `Tron tx ${txid} did not succeed (receipt.result=${info.receipt?.result ?? 'none'}).`,
    }
  }

  // Replay window: reject ancient payments. blockTimeStamp is in milliseconds.
  const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(info.blockTimeStamp / 1000)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: Number.isFinite(ageSeconds)
        ? `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`
        : `Cannot determine the age of ${txid} (no blockTimeStamp) — fail closed.`,
    }
  }

  const { total, from } = sumTransfersTo(info.log ?? [], tokenHex20, payToHex20)
  if (total < required) {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail: `No TRC-20 Transfer of >= ${required} (token ${accept.asset}) to ${accept.payTo} in ${txid}.`,
    }
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: txid,
      asset: accept.asset,
      amount: accept.amount,
      payer: from ? toBase58(from) : '',
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

export interface VerifyTronNativeParams {
  reader: TronReader
  accept: X402AcceptEntry
  /** The proof txid (bare hex). */
  txid: string
  /** payTo as 0x41-prefixed hex (the form Tron TransferContract carries), lowercase. */
  payToHex41: string
  /** 0x41-prefixed hex → Base58 T… — for the receipt's payer field. */
  toBase58: (hex41: string) => string
}

/**
 * Verify a NATIVE-TRX payment (digest-bound). Finality + recency come from the
 * SOLIDITY node (`getTransactionInfo` — present ⇒ solidified); the value/recipient
 * come from the raw tx's `TransferContract` (native transfers emit no event log).
 */
export async function verifyTronNative(params: VerifyTronNativeParams): Promise<VerifyResult> {
  const { reader, accept, txid, payToHex41, toBase58 } = params
  const required = BigInt(accept.amount)

  // 1) Finality gate: a confirmed tx exists on the solidity node (else transient).
  let info: TronTxInfo | null
  try {
    info = await reader.getTransactionInfo(txid)
  } catch {
    return txNotFound(txid)
  }
  if (!info || !info.id) return txNotFound(txid)

  // Native TransferContract info usually carries no receipt.result, so use a TRUTHY gate: reject
  // only an explicitly non-SUCCESS result (fail closed on a populated failure), never a legit native
  // tx whose result is absent. (The TRC-20 path above uses the stricter "must be SUCCESS" form.)
  if (info.receipt?.result && info.receipt.result !== 'SUCCESS') {
    return { ok: false, error: 'tx_reverted', detail: `Tron tx ${txid} did not succeed (receipt.result=${info.receipt.result}).` }
  }

  // Replay window (blockTimeStamp is ms).
  const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(info.blockTimeStamp / 1000)
  if (!Number.isFinite(ageSeconds) || ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: Number.isFinite(ageSeconds)
        ? `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`
        : `Cannot determine the age of ${txid} (no blockTimeStamp) — fail closed.`,
    }
  }

  // 2) The transfer itself: read the raw tx's TransferContract.
  let tx: TronRawTx | null
  try {
    tx = await reader.getTransaction(txid)
  } catch {
    return txNotFound(txid)
  }
  if (!tx) return txNotFound(txid)

  const ret = tx.ret?.[0]?.contractRet
  if (ret && ret !== 'SUCCESS') {
    return { ok: false, error: 'tx_reverted', detail: `Tron tx ${txid} did not succeed (contractRet=${ret}).` }
  }

  const contract = (tx.raw_data?.contract ?? [])[0]
  if (!contract || contract.type !== 'TransferContract') {
    return {
      ok: false,
      error: 'transfer_not_found',
      detail: `Tron tx ${txid} is not a native TRX transfer (TransferContract).`,
    }
  }
  const value = contract.parameter?.value ?? {}
  const to = String(value.to_address ?? '').toLowerCase().replace(/^0x/, '')
  if (to !== payToHex41) {
    return { ok: false, error: 'wrong_recipient', detail: `Native TRX in ${txid} was not sent to ${accept.payTo}.` }
  }
  const amount = (() => {
    try {
      return BigInt(value.amount ?? 0)
    } catch {
      return 0n
    }
  })()
  if (amount < required) {
    return { ok: false, error: 'amount_too_low', detail: `Sent ${amount} sun, required ${required}.` }
  }

  const from = String(value.owner_address ?? '').toLowerCase().replace(/^0x/, '')
  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: txid,
      asset: 'native',
      amount: accept.amount,
      payer: from ? toBase58(from) : '',
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/**
 * Sum every TRC-20 Transfer of `tokenHex20` to `payToHex20` in these logs.
 * Summing (rather than first-match) tolerates split transfers across logs.
 */
function sumTransfersTo(
  logs: TronLog[],
  tokenHex20: string,
  payToHex20: string
): { total: bigint; from: string | null } {
  let total = 0n
  let from: string | null = null

  for (const log of logs) {
    if ((log.address ?? '').toLowerCase() !== tokenHex20) continue
    const topics = log.topics ?? []
    if (topics.length < 3) continue
    if ((topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue
    if (last20(topics[2]) !== payToHex20) continue
    try {
      total += BigInt(`0x${log.data}`)
      from = last20(topics[1])
    } catch {
      /* not a standard Transfer log — skip */
    }
  }

  return { total, from }
}

/** Last 20 bytes (40 hex chars) of a 32-byte topic, lowercased. */
function last20(topic: string | undefined): string {
  return (topic ?? '').slice(-40).toLowerCase()
}

/** Transient: not yet solidified, or the RPC read failed (ERRORS.md §5). */
function txNotFound(txid: string): VerifyResult {
  return {
    ok: false,
    error: 'tx_not_found',
    detail: `Tron tx ${txid} not found or not yet confirmed (solidified) — retry.`,
  }
}
