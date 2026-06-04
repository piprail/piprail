/**
 * ── ALGORAND SECTION: pay ──
 * Build, sign, and submit an Algorand transfer to `payTo`, returning the tx id.
 *   - native ALGO → a payment txn (tx-type `pay`)
 *   - USDC / ASA  → an asset-transfer txn (tx-type `axfer`, with the asset id)
 *
 * Template A (memo-bound): the challenge nonce rides in the transaction's **note
 * field** (raw UTF-8 bytes; the 1KB cap dwarfs a 36-char UUID, so no hashing is
 * needed) and verify() re-derives it from the trusted `accept`. So a proof is
 * cryptographically bound to its challenge — a stranger's payment can't satisfy a
 * different one.
 *
 * Algorand amounts are integer base units (microAlgos / 6dp USDC), like EVM, so
 * `accept.amount` is used verbatim (no human-decimal-string re-scaling).
 *
 * The client is injected behind a narrow interface so this is unit-testable with a
 * mock; the real algosdk client is adapted in index.ts.
 */
import {
  InsufficientFundsError,
  RecipientNotReadyError,
  toInsufficientFundsError,
  type PipRailError,
} from '../../errors.js'
import { parseAlgorandAssetId } from './chains.js'
import type { X402AcceptEntry } from '../../x402.js'

/** A value transfer to build — native ALGO when `assetId` is undefined, else an ASA. */
export interface AlgorandTransfer {
  sender: string
  receiver: string
  amount: bigint
  note: Uint8Array
  /** ASA id; undefined => native ALGO payment. */
  assetId?: number
}

/** The slice of the Algorand client the pay path needs — adapted from a real client in index.ts. */
export interface AlgorandPayClient {
  /** Build the transfer txn (pay or axfer) and return its deterministic tx id. */
  build(transfer: AlgorandTransfer): Promise<{ txn: unknown; txId: string }>
  /** Sign with the account's secret key and submit; resolve once accepted into the pool. */
  signSend(input: { txn: unknown; sk: Uint8Array }): Promise<void>
}

export interface PayAlgorandParams {
  client: AlgorandPayClient
  /** The account's 64-byte secret key. */
  sk: Uint8Array
  /** The payer's address. */
  sender: string
  accept: X402AcceptEntry
}

export async function payAlgorand(params: PayAlgorandParams): Promise<string> {
  const { client, sk, sender, accept } = params
  const note = new TextEncoder().encode(accept.extra.nonce)
  const amount = BigInt(accept.amount)
  const assetId = parseAlgorandAssetId(accept.asset) // null => native ALGO
  try {
    const { txn, txId } = await client.build({
      sender,
      receiver: accept.payTo,
      amount,
      note,
      ...(assetId === null ? {} : { assetId }),
    })
    await client.signSend({ txn, sk })
    return txId
  } catch (err) {
    const mapped = mapAlgorandError(err, accept.payTo)
    if (mapped) throw mapped
    throw toInsufficientFundsError(err) ?? err
  }
}

/**
 * Map an algod submit failure to one of the SDK's typed errors (ERRORS.md §7):
 *   - recipient hasn't opted into the ASA → RecipientNotReadyError (fix the DESTINATION);
 *   - sender overspend / below min balance / missing the asset → InsufficientFundsError.
 * Returns null for anything unrecognised so the original error propagates unchanged.
 */
function mapAlgorandError(err: unknown, payTo: string): PipRailError | null {
  const m = err instanceof Error ? err.message : String(err)
  // Receiver not set up to hold the ASA (must opt-in first) → fix the recipient.
  if (/must optin/i.test(m) || (/missing from/i.test(m) && m.includes(payTo))) {
    return new RecipientNotReadyError(
      `Algorand recipient ${payTo} hasn't opted into this asset — it must opt in ` +
        `(a 0-amount asset transfer to itself) before it can receive. (Algorand: ${firstLine(m)})`,
      { cause: err }
    )
  }
  // Sender affordability / setup: overspend, min-balance, or the sender missing the asset.
  if (
    /overspend|below min|min(imum)? balance|tried to spend|balance \d+ below|asset \d+ missing from|insufficient|underflow/i.test(
      m
    )
  ) {
    return new InsufficientFundsError(
      `Algorand payment failed: the sender can't cover it — token balance, ALGO for fees, ` +
        `the 0.1-ALGO minimum balance, or a missing asset opt-in on the sender. (Algorand: ${firstLine(m)})`,
      { cause: err }
    )
  }
  return null
}

function firstLine(message: string): string {
  return message.split('\n')[0]!.slice(0, 160)
}
