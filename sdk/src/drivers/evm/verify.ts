import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import type { X402AcceptEntry, VerifyResult } from '../../x402.js'

/**
 * ── EVM SECTION: verify ──
 * Local, RPC-only verification of an EVM payment. Runs entirely in your
 * process.
 *
 * Given a transaction hash and the requirements we issued, confirm — using
 * nothing but the chain's public RPC — that the transaction:
 *   1. exists and succeeded,
 *   2. has enough confirmations,
 *   3. actually moved `amount` of `asset` to `payTo`, and
 *   4. is recent (mined within `maxTimeoutSeconds`), so an old payment to
 *      the same address can't be replayed.
 *
 * Double-spend of the *same* tx hash is prevented one level up, by the
 * payment gate's used-tx set (see server.ts).
 */
export interface VerifyEvmParams {
  publicClient: PublicClient
  txHash: Hex
  /** The requirements the server issued for this resource. */
  accept: X402AcceptEntry
  minConfirmations: number
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

export async function verifyEvm(
  params: VerifyEvmParams
): Promise<VerifyResult> {
  const { publicClient, txHash, accept, minConfirmations } = params
  const requiredAmount = BigInt(accept.amount)
  const payTo = getAddress(accept.payTo)

  let receipt
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  } catch {
    return {
      ok: false,
      error: 'tx_not_found',
      detail: `Transaction ${txHash} not found or not yet mined.`,
    }
  }

  if (receipt.status !== 'success') {
    return {
      ok: false,
      error: 'tx_reverted',
      detail: `Transaction ${txHash} reverted on-chain.`,
    }
  }

  // Follow-on reads: a transient RPC failure here must NOT escape the verify
  // channel — return tx_not_found (the retryable bucket), never throw raw.
  let latestBlock: bigint
  let block
  try {
    latestBlock = await publicClient.getBlockNumber()
    block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  } catch {
    return {
      ok: false,
      error: 'tx_not_found',
      detail: `Could not read chain state for ${txHash} (transient RPC failure) — retry.`,
    }
  }
  const confirmations =
    latestBlock >= receipt.blockNumber
      ? latestBlock - receipt.blockNumber + 1n
      : 0n
  if (confirmations < BigInt(minConfirmations)) {
    return {
      ok: false,
      error: 'insufficient_confirmations',
      detail: `Need ${minConfirmations} confirmation(s), have ${confirmations}.`,
    }
  }

  // Replay window: reject ancient payments to the same address.
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp)
  if (ageSeconds > accept.maxTimeoutSeconds) {
    return {
      ok: false,
      error: 'payment_expired',
      detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
    }
  }

  let payer: `0x${string}`

  if (accept.asset === 'native') {
    let tx
    try {
      tx = await publicClient.getTransaction({ hash: txHash })
    } catch {
      return {
        ok: false,
        error: 'tx_not_found',
        detail: `Could not read ${txHash} (transient RPC failure) — retry.`,
      }
    }
    if (!tx.to || getAddress(tx.to) !== payTo) {
      return {
        ok: false,
        error: 'wrong_recipient',
        detail: `Native payment in ${txHash} was not sent to ${payTo}.`,
      }
    }
    if (tx.value < requiredAmount) {
      return {
        ok: false,
        error: 'amount_too_low',
        detail: `Sent ${tx.value}, required ${requiredAmount}.`,
      }
    }
    payer = getAddress(tx.from)
  } else {
    const asset = getAddress(accept.asset)
    const transferred = sumTransfersTo(receipt.logs, asset, payTo)
    if (transferred.total < requiredAmount) {
      return {
        ok: false,
        error: 'transfer_not_found',
        detail: `No ERC-20 Transfer of >= ${requiredAmount} (token ${asset}) to ${payTo} in ${txHash}.`,
      }
    }
    payer = transferred.from ?? ZERO_ADDRESS
  }

  return {
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: txHash,
      asset: accept.asset,
      amount: accept.amount,
      payer,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/**
 * Sum every ERC-20 Transfer to `payTo` emitted by `asset` in this receipt.
 * Summing (rather than first-match) tolerates fee-on-transfer or split
 * transfers that land in more than one log.
 */
function sumTransfersTo(
  logs: Log[],
  asset: `0x${string}`,
  payTo: `0x${string}`
): { total: bigint; from: `0x${string}` | null } {
  let total = 0n
  let from: `0x${string}` | null = null

  for (const log of logs) {
    if (getAddress(log.address) !== asset) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== 'Transfer') continue
      const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; value: bigint }
      if (getAddress(args.to) !== payTo) continue
      total += args.value
      from = getAddress(args.from)
    } catch {
      /* not a standard Transfer log — skip */
    }
  }

  return { total, from }
}
