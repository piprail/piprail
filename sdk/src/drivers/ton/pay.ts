/**
 * ── TON SECTION: pay ──
 * Build, sign, and broadcast a TON payment, then wait for the wallet to accept
 * the external message (its seqno advances). Two branches:
 *   - native TON → one internal message to `payTo` (value = amount), comment = nonce
 *   - jetton     → a TEP-74 transfer (op 0x0f8a7ea5) to OUR jetton wallet, which
 *                  forwards the tokens to `payTo`; the nonce rides along as the
 *                  forward comment so the server can bind the proof to this
 *                  challenge.
 *
 * The opened wallet is injected so this stays a focused builder; the driver
 * (index.ts) owns address derivation. Confirmed against live USD₮-TON sends.
 */
import { Address, beginCell, comment as commentCell, internal, toNano, type Cell } from '@ton/core'
import { SendMode, type TonClient } from '@ton/ton'
import { ConfirmationTimeoutError } from '../../errors.js'
import { delay } from '../../util/async.js'
import type { X402AcceptEntry } from '../../x402.js'
import type { TonWallet } from './wallet.js'

/** op::transfer (TEP-74). Confirmed against live USD₮-TON transactions. */
const OP_JETTON_TRANSFER = 0x0f8a7ea5
/** TON attached to a jetton transfer for fees + forwarding; leftover is refunded. */
const JETTON_GAS = toNano('0.05')
/** Nanoton forwarded with the credit. The comment rides in `internal_transfer`
 * regardless, so a minimal amount keeps cost down while still notifying. */
const FORWARD_TON = 1n

export interface PayTonParams {
  client: Pick<TonClient, 'open'>
  wallet: TonWallet
  accept: X402AcceptEntry
  /** OUR jetton wallet (sender side) — required for a jetton payment. */
  senderJettonWallet?: Address
}

export async function payTon(params: PayTonParams): Promise<void> {
  const { client, wallet, accept, senderJettonWallet } = params
  const opened = client.open(wallet.contract)
  const seqno = await opened.getSeqno()
  const cmt = commentCell(accept.extra.nonce)

  const message =
    accept.asset === 'native'
      ? internal({
          to: Address.parse(accept.payTo),
          value: BigInt(accept.amount),
          bounce: false,
          body: cmt,
        })
      : internal({
          to: senderJettonWallet as Address,
          value: JETTON_GAS,
          bounce: true,
          body: buildJettonTransfer(accept, wallet.contract.address, cmt),
        })

  await opened.sendTransfer({
    seqno,
    secretKey: wallet.keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    messages: [message],
  })

  await waitForSeqno(opened, seqno)
}

/** TEP-74 jetton transfer body: tokens go to `payTo`, the nonce as forward comment. */
function buildJettonTransfer(
  accept: X402AcceptEntry,
  responseTo: Address,
  forward: Cell
): Cell {
  return beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(0n, 64) // query_id
    .storeCoins(BigInt(accept.amount)) // jetton amount (base units)
    .storeAddress(Address.parse(accept.payTo)) // destination owner
    .storeAddress(responseTo) // response_destination — refund leftover TON
    .storeBit(false) // no custom_payload
    .storeCoins(FORWARD_TON) // forward_ton_amount
    .storeBit(true) // forward_payload stored as a ref
    .storeRef(forward) // the comment cell (our nonce)
    .endCell()
}

/** Poll until the wallet's seqno advances past `from` — its external message landed. */
async function waitForSeqno(
  opened: { getSeqno: () => Promise<number> },
  from: number,
  { tries = 30, intervalMs = 2000 } = {}
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    await delay(intervalMs)
    let current: number
    try {
      current = await opened.getSeqno()
    } catch {
      continue // transient RPC hiccup (e.g. rate limit) — keep waiting
    }
    if (current > from) return
  }
  throw new ConfirmationTimeoutError(
    `TON wallet seqno did not advance past ${from} — the payment may not have been accepted.`
  )
}
