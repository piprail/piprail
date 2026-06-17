/**
 * ── NEAR SECTION: x402 `exact` scheme — BUYER side (facilitator-settled) ──────
 *
 * PipRail's own NEAR gates default to `onchain-proof` (the buyer broadcasts a normal
 * `ft_transfer` and proves it with the memo nonce). This module is the standard x402
 * `exact` interop for NEAR, on the existing `near-api-js` lazy peer (no new dep) — the
 * BUYER half of `specs/schemes/exact/scheme_exact_near.md` (ratified, x402 v2).
 *
 *   • BUYER side (client) — {@link payExactNear} builds a **NEP-366 `SignedDelegateAction`**
 *     authorizing exactly one NEP-141 `ft_transfer` (to `payTo`, the exact `amount`, attached
 *     `deposit: 1` yoctoNEAR), signs it with the buyer's FULL-ACCESS key, and emits the
 *     base64 Borsh as `{ signedDelegateAction }`. The buyer holds **zero NEAR** — a
 *     facilitator-selected relayer wraps the delegate in its own outer transaction, prepays
 *     the gas + the yocto, and submits.
 *
 * **Why facilitator-only (no PipRail self-settle).** Unlike EVM/Solana/Algorand/Aptos — whose
 * `exact` schemes let the merchant be the fee-payer of the SAME transaction (co-sign one slot)
 * — the NEAR scheme has the relayer wrap the delegate in a SEPARATE outer transaction it fully
 * owns, then wait for the inner `ft_transfer` receipt to finish executing across shards. Doing
 * that on the gate means running a funded, hot-key, stateful NEAR relayer — exactly the backend
 * role PipRail's charter avoids. The keyless x402 facilitator (e.g. Ultravioleta DAO's
 * `uvd-facilitator.near`) already performs it gaslessly for BOTH buyer and merchant, so PipRail
 * forwards verify+settle to it (Mode-B in `facilitator.ts`) and ships only the buyer primitive
 * here. (Native NEAR is NOT exact-payable — the scheme is defined over `ft_transfer`; native
 * stays `onchain-proof`, exactly as EVM/Solana exclude their native coin.)
 *
 * The sponsor fee-drain guard lives on the SETTLE side, which is the facilitator's here: the
 * scheme makes the facilitator cap the relayer gas it prepays (§3/§7). On the buyer side we set
 * a fixed, modest `ft_transfer` gas so an honest payload never trips that cap.
 */
import { actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js'
import type { Signer } from 'near-api-js'
import { UnsupportedSchemeError } from '../../errors.js'
import { isValidNearAccountId } from './chains.js'
import type { ExactNearPaymentPayload, X402ExactAcceptEntry } from '../../x402.js'

/**
 * Fixed gas for the delegated `ft_transfer`: **30 TGas**. A NEP-141 `ft_transfer` burns ~14 TGas;
 * 30 is comfortable headroom yet far below any facilitator relayer gas cap — so an honest PipRail
 * payload never trips the sponsor's drain guard. The relayer (not the buyer) prepays this gas.
 */
const FT_TRANSFER_GAS = 30_000_000_000_000n // 30 TGas

/**
 * The NEP-141 `ft_transfer` security marker: exactly **1 yoctoNEAR** of attached deposit. It forces
 * the call to be authorized by a FULL-ACCESS key (function-call access keys can't attach a positive
 * NEAR deposit), which is why the buyer MUST sign with a full-access key. The relayer prepays this
 * yocto when it submits the outer transaction — the buyer still holds zero NEAR.
 */
const ONE_YOCTO = 1n

/** Per the scheme's deterministic timeout mapping, `estimatedBlockSeconds = 1` on near:mainnet/testnet,
 *  so `timeoutBlocks = ceil(maxTimeoutSeconds / 1)`. */
const ESTIMATED_BLOCK_SECONDS = 1

/** NEAR's delegate-action nonce upper bound: a delegate action's nonce MUST be `< height * 1e6`. */
const NONCE_BLOCK_MULTIPLIER = 1_000_000n

/**
 * BUYER — build + sign a NEAR `exact` payment for a standard x402 `exact` rail (per
 * `scheme_exact_near.md`). Pure + RPC-free: the caller pre-reads the signing access key's `nonce`
 * and the current final `blockHeight` (the driver does the two RPC reads) and passes them in, so
 * this stays unit-testable with a real {@link Signer} and no network.
 *
 * Builds a NEP-366 `DelegateAction` carrying exactly one `ft_transfer` FunctionCall
 * (`receiver_id: payTo`, `amount`, `deposit: 1` yocto, fixed 30 TGas), sets `nonce = accessKeyNonce + 1`
 * and `max_block_height = blockHeight + timeoutBlocks`, signs it (the signer applies the NEP-461
 * prefix), and Borsh-encodes the `SignedDelegateAction` to base64. Returns the `{ signedDelegateAction }`
 * payload, the payer account id, and a stable dedupe `nonce` (`<account>:<delegate-nonce>` — the
 * on-chain access-key nonce makes the action single-use).
 *
 * THROWS {@link UnsupportedSchemeError} for native (not exact-payable), a non-NEP-141 `asset`, an
 * invalid `payTo`, a non-positive `maxTimeoutSeconds`, or a nonce at the protocol ceiling.
 */
export async function payExactNear(input: {
  /** The buyer's signer (a full-access key — a function-call key would be rejected on-chain). */
  signer: Signer
  /** The buyer's account id (the delegate `sender_id`). */
  senderId: string
  /** Current FINAL block height (pre-read by the driver) — for `max_block_height`. */
  blockHeight: bigint
  /** The signing access key's current `nonce` (pre-read by the driver). */
  accessKeyNonce: bigint
  accept: X402ExactAcceptEntry
}): Promise<{ payload: ExactNearPaymentPayload; payerFrom: string; nonce: string }> {
  const { signer, senderId, blockHeight, accessKeyNonce, accept } = input

  if (accept.asset === 'native') {
    throw new UnsupportedSchemeError(
      'NEAR exact is NEP-141-only (an ft_transfer); native NEAR is not exact-payable. Pay via onchain-proof.'
    )
  }
  if (!isValidNearAccountId(accept.asset)) {
    throw new UnsupportedSchemeError(`NEAR exact: asset "${accept.asset}" must be a NEP-141 contract account id.`)
  }
  if (!isValidNearAccountId(accept.payTo)) {
    throw new UnsupportedSchemeError(`NEAR exact: payTo "${accept.payTo}" is not a valid NEAR account id.`)
  }
  if (!isValidNearAccountId(senderId)) {
    throw new UnsupportedSchemeError(`NEAR exact: sender "${senderId}" is not a valid NEAR account id.`)
  }
  const t = accept.maxTimeoutSeconds
  if (!Number.isInteger(t) || t <= 0) {
    throw new UnsupportedSchemeError('NEAR exact: maxTimeoutSeconds must be a positive integer.')
  }

  // Deterministic timeout → block mapping (scheme MUST): timeoutBlocks = ceil(maxTimeoutSeconds / 1).
  const timeoutBlocks = BigInt(Math.max(1, Math.ceil(t / ESTIMATED_BLOCK_SECONDS)))
  const maxBlockHeight = blockHeight + timeoutBlocks
  const nonce = accessKeyNonce + 1n
  // Scheme replay rule: a delegate-action nonce MUST be < current_block_height * 1_000_000.
  if (nonce >= blockHeight * NONCE_BLOCK_MULTIPLIER) {
    throw new UnsupportedSchemeError(
      'NEAR exact: the access-key nonce is at the protocol ceiling for this block height; cannot build a delegate action.'
    )
  }

  const publicKey = await signer.getPublicKey()
  // One FunctionCall: ft_transfer to payTo, exact amount (a decimal string), 1 yocto, fixed gas.
  const action = actions.functionCall(
    'ft_transfer',
    { receiver_id: accept.payTo, amount: accept.amount },
    FT_TRANSFER_GAS,
    ONE_YOCTO
  )
  // receiverId = the NEP-141 token CONTRACT (the delegate's receiver), per the scheme.
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId: accept.asset,
    actions: [action],
    nonce,
    maxBlockHeight,
    publicKey,
  })
  const { signedDelegate } = await signer.signDelegateAction(delegateAction)
  const encoded = encodeSignedDelegate(signedDelegate)

  return {
    payload: { signedDelegateAction: Buffer.from(encoded).toString('base64') },
    payerFrom: senderId,
    // A stable id for THIS authorization (single-use on-chain via the access-key nonce): the
    // client records it as the spend ref and re-presents the SAME signed action on a retry.
    nonce: `${senderId}:${nonce.toString()}`,
  }
}
