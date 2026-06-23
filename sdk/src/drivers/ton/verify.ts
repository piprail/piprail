/**
 * ── TON SECTION: verify ──
 * Local, RPC-only verification of a TON payment. Mirrors the EVM/Solana
 * verifiers' guarantees: the transfer exists, succeeded, is recent (replay
 * window), and actually moved >= `amount` of the right token to `payTo`.
 *
 * TON settles value asynchronously across contracts, so we verify the way the
 * network itself does: we read the **merchant's jetton wallet** — the single
 * account a jetton credit lands on, derived from the OFFICIAL jetton master, so
 * a look-alike jetton can't satisfy the check — and look for the incoming
 * `internal_transfer` (op 0x178d4519) carrying our challenge nonce in its
 * forward comment. Native TON is read from the incoming message's value + text
 * comment to `payTo`. Because the nonce rides in the comment, a TON proof is
 * bound to the challenge that issued it.
 *
 * The ops + parsing were confirmed against live USD₮-TON transactions before
 * shipping. `client` is injected (only getTransactions is used) so this is
 * unit-testable with a mock.
 */
import type { Address, Cell, Slice, Transaction } from '@ton/core'
import type { TonClient } from '@ton/ton'
import type { VerifyResult, X402AcceptEntry } from '../../x402.js'

/** op::internal_transfer — the credit a jetton wallet receives (TEP-74 ref). */
const OP_INTERNAL_TRANSFER = 0x178d4519
/** A text-comment cell is prefixed with a 0x00000000 op. */
const OP_TEXT_COMMENT = 0x00000000

export interface VerifyTonParams {
  client: Pick<TonClient, 'getTransactions'>
  /** Merchant jetton wallet (jetton) or `payTo` (native) — the account to read. */
  watch: Address
  accept: X402AcceptEntry
}

export async function verifyTon(params: VerifyTonParams): Promise<VerifyResult> {
  const { client, watch, accept } = params
  const required = BigInt(accept.amount)
  const nonce = accept.extra.nonce

  let txs: Transaction[]
  try {
    txs = await client.getTransactions(watch, { limit: 24, archival: true })
  } catch {
    // A failed RPC READ is transient (not a definitive "no transfer") → tx_not_found,
    // uniform with EVM/Solana and the verify() contract in ERRORS.md §5.
    return {
      ok: false,
      error: 'tx_not_found',
      detail: `Could not read the TON account for nonce ${nonce} (transient RPC failure) — retry.`,
    }
  }

  for (const tx of txs) {
    // ASSET-BOUND: a native accept is satisfied ONLY by a real native value transfer, and a jetton
    // accept ONLY by a real internal_transfer credit — so a dust native message carrying a FORGED
    // internal_transfer body (claiming a huge amount) can't satisfy a native accept, and vice-versa.
    const incoming = extractIncoming(tx, accept.asset === 'native' ? 'native' : 'jetton')
    if (!incoming || incoming.comment !== nonce) continue

    // Found the payment bound to this challenge. Hold it to the same bar as the
    // EVM/Solana verifiers: succeeded, enough value, recent.
    //
    // The success check is JETTON-ONLY. A jetton credit lands on the merchant's
    // jetton-wallet contract, which must EXECUTE the `internal_transfer` to credit the
    // balance — so an aborted/failed compute means the tokens didn't move. But a NATIVE
    // TON transfer credits value by message delivery itself: a non-bounced internal
    // message (we already exclude bounced ones in extractIncoming) adds its value to the
    // recipient regardless of the recipient's compute phase — which is in fact
    // skipped/aborted when the recipient wallet isn't deployed yet (a brand-new payTo).
    // Gating native on txSucceeded wrongly rejects a payment the merchant actually
    // received. So only jetton credits are held to the compute-success bar.
    if (accept.asset !== 'native' && !txSucceeded(tx)) {
      return { ok: false, error: 'tx_reverted', detail: `TON payment for nonce ${nonce} failed on-chain.` }
    }
    if (incoming.amount < required) {
      return { ok: false, error: 'amount_too_low', detail: `Credited ${incoming.amount}, required ${required}.` }
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - tx.now
    if (ageSeconds > accept.maxTimeoutSeconds) {
      return {
        ok: false,
        error: 'payment_expired',
        detail: `Payment is ${ageSeconds}s old; max allowed is ${accept.maxTimeoutSeconds}s.`,
      }
    }

    return {
      ok: true,
      receipt: {
        scheme: 'onchain-proof',
        success: true,
        network: accept.network,
        transaction: tx.hash().toString('hex'),
        asset: accept.asset,
        amount: accept.amount,
        payer: incoming.payer,
        payTo: accept.payTo,
        verifiedAt: new Date().toISOString(),
      },
    }
  }
  return notFound(nonce)
}

export interface Incoming {
  /** Base units: jetton amount for a credit, nanoton for a native transfer. */
  amount: bigint
  /** The payer's owner address (friendly form). */
  payer: string
  /** The text comment, if any — we bind it to the challenge nonce. */
  comment?: string
}

/**
 * Read the incoming value + comment from a transaction, **bound to the expected asset kind**.
 * The `kind` MUST come from `accept.asset` — this is the security boundary that stops a
 * cross-asset confusion:
 *   - `'jetton'`: honor ONLY a real `internal_transfer` credit (the merchant's jetton wallet);
 *     a native/comment message returns `null` (it can't satisfy a jetton accept).
 *   - `'native'`: honor ONLY the message's REAL on-chain value (`inMsg.info.value.coins`); a
 *     jetton-SHAPED body returns `null` — so a dust transfer carrying a forged `internal_transfer`
 *     body that *claims* a huge amount can never satisfy a native accept.
 * Returns `null` if the in-message isn't a usable incoming internal message of the expected kind.
 */
export function extractIncoming(tx: Transaction, kind: 'native' | 'jetton'): Incoming | null {
  const inMsg = tx.inMessage
  if (!inMsg || inMsg.info.type !== 'internal' || inMsg.info.bounced) return null

  const jetton = parseInternalTransfer(inMsg.body)
  if (kind === 'jetton') {
    if (!jetton) return null
    return {
      amount: jetton.amount,
      payer: (jetton.from ?? inMsg.info.src).toString(),
      comment: jetton.comment,
    }
  }
  // kind === 'native': never trust a jetton-shaped body's claimed amount — read the REAL value moved.
  if (jetton) return null
  return {
    amount: inMsg.info.value.coins,
    payer: inMsg.info.src.toString(),
    comment: readComment(inMsg.body),
  }
}

/**
 * A transaction is good only if it actually RAN its compute phase successfully. Used for the
 * JETTON path only (the native carve-out at the call site bypasses this — native value is credited
 * by message delivery, so a not-yet-deployed payTo legitimately has a skipped compute).
 *
 * A jetton credit lands on the merchant's jetton-wallet contract, which MUST execute the
 * `internal_transfer` to credit the balance — so we require a successful `vm` compute phase.
 * Crucially we reject a `skipped` (e.g. `cskip_no_state`) compute: an attacker can send a
 * non-bounceable message carrying a FORGED `internal_transfer` body (claiming a huge amount) to the
 * merchant's UNDEPLOYED jetton wallet — it lands `aborted=false` with a skipped compute and credits
 * NOTHING, yet the forged body would otherwise read as a credit. Requiring `vm` + `success` rejects
 * it. A legitimate first-ever jetton credit arrives with `state_init`, deploys the wallet, and runs
 * a successful `vm` phase, so this never rejects a real payment. We also reject an explicit
 * action-phase failure (compute-ok-but-action-failed never moved the tokens).
 */
export function txSucceeded(tx: Transaction): boolean {
  const d = tx.description
  if (d.type !== 'generic') return false
  if (d.aborted) return false
  if (d.computePhase.type !== 'vm' || !d.computePhase.success) return false
  if (d.actionPhase && d.actionPhase.success === false) return false
  return true
}

function parseInternalTransfer(
  body: Cell
): { amount: bigint; from: Address | null; comment?: string } | null {
  try {
    const s = body.beginParse()
    if (s.remainingBits < 32) return null
    if (s.loadUint(32) !== OP_INTERNAL_TRANSFER) return null
    s.loadUintBig(64) // query_id
    const amount = s.loadCoins()
    const from = s.loadMaybeAddress() // sender's OWNER address
    s.loadMaybeAddress() // response_address
    s.loadCoins() // forward_ton_amount
    return { amount, from, comment: readForwardComment(s) }
  } catch {
    return null
  }
}

/** forward_payload is `(Either Cell ^Cell)`: a 1-bit tag, then inline or a ref. */
function readForwardComment(s: Slice): string | undefined {
  try {
    const cs = s.loadBit() ? s.loadRef().beginParse() : s
    if (cs.remainingBits < 32) return undefined
    if (cs.loadUint(32) !== OP_TEXT_COMMENT) return undefined
    return cs.loadStringTail()
  } catch {
    return undefined
  }
}

/** A native transfer's body is a bare comment cell (op 0 + snake string). */
function readComment(body: Cell): string | undefined {
  try {
    const s = body.beginParse()
    if (s.remainingBits < 32) return undefined
    if (s.loadUint(32) !== OP_TEXT_COMMENT) return undefined
    return s.loadStringTail()
  } catch {
    return undefined
  }
}

function notFound(nonce: string): VerifyResult {
  return {
    ok: false,
    error: 'transfer_not_found',
    detail:
      `No matching TON transfer found for nonce ${nonce} ` +
      `(not yet settled, or wrong recipient/amount/token).`,
  }
}
