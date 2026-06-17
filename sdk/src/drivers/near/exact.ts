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
 *     base64 Borsh as `{ signedDelegateAction }`. The buyer holds **zero NEAR** — a relayer
 *     wraps the delegate in its own outer transaction, prepays the gas + the yocto, and submits.
 *
 *   • SELLER side (gate, SELF-SETTLE) — {@link verifyAndSettleExactNear} decodes the inbound
 *     `signedDelegateAction`, re-derives every checked field from the TRUSTED `accept` (token /
 *     `payTo` / amount / the 1-yocto deposit / a gas CAP — the sponsor-drain guard), then RELAYS
 *     it from the merchant's own NEAR relayer (which prepays the sub-cent gas + the yocto) and
 *     waits for the inner `ft_transfer` receipt. The BUYER still pays zero NEAR; the merchant's
 *     relayer pays the network fee to receive — exactly like our EVM/Solana/Algorand/Aptos
 *     self-settle. This is what lets a PipRail NEAR gate get PAID by a standard `exact` client
 *     today, without any third-party facilitator.
 *
 * **Settle modes.** NEAR `exact` is **self-settle today** (the gate's own relayer, above) because
 * **no third-party x402 facilitator settles NEAR yet** — UVD advertises `near:mainnet` in
 * `/supported` but its x402-rs has no NEAR implementation and `/verify` rejects the request
 * (verified 2026-06-18). The protocol layer's facilitator path (Mode-B in `facilitator.ts`) will
 * "just work" the moment a real NEAR facilitator ships — wire it up by seeding `facilitators.ts`
 * then. Unlike EVM/Solana/Algorand, the NEAR relayer wraps the delegate in a SEPARATE outer
 * transaction it fully owns (the merchant runs a funded relayer key), then waits for the inner
 * receipt across shards. (Native NEAR is NOT exact-payable — the scheme is over `ft_transfer`;
 * native stays `onchain-proof`, exactly as EVM/Solana exclude their native coin.)
 *
 * **Sponsor fee-drain guard** (ERRORS.md §5 / [[sponsor-fee-drain-guard]]): the relayer prepays
 * BOTH the gas AND the attached deposit of the delegated call, so a malicious buyer could drain it
 * by signing a valid sub-cent transfer with a huge `gas` or a large `deposit`. `verifyAndSettleExactNear`
 * therefore rejects any delegate whose attached `deposit` ≠ exactly 1 yocto or whose `gas` exceeds
 * {@link MAX_RELAY_GAS} BEFORE the relayer ever signs. The buyer side sets a fixed modest gas so an
 * honest payload never trips it.
 */
import { actions, buildDelegateAction, encodeSignedDelegate, DelegateAction, SCHEMA } from 'near-api-js'
import type { Signer } from 'near-api-js'
import { deserialize } from 'borsh'
import { UnsupportedSchemeError, SettlementError } from '../../errors.js'
import { isValidNearAccountId } from './chains.js'
import type {
  ExactNearPaymentPayload,
  VerifyErrorCode,
  VerifyResult,
  X402ExactAcceptEntry,
} from '../../x402.js'

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

/* ───────────────────────────── SELLER SIDE (gate, self-settle) ────────────────────────────── */

/**
 * Cap on the gas the RELAYER will prepay for the delegated `ft_transfer`: **300 TGas**. The honest
 * buyer signs ~30 TGas (see {@link FT_TRANSFER_GAS}); a NEP-141 transfer never needs more than a
 * fraction of this. WITHOUT the cap, a malicious buyer could sign a valid sub-cent transfer with an
 * enormous `gas` and the relayer would prepay it on submit — draining the relayer's NEAR. (The 1-yocto
 * deposit is the other prepaid leg, capped to exactly 1 yocto below.) The sponsor fee-drain guard for
 * NEAR — mirrors the Algorand/Aptos/Solana caps; see [[sponsor-fee-drain-guard]] / ERRORS.md §5.
 */
const MAX_RELAY_GAS = 300_000_000_000_000n // 300 TGas

const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

function fail(error: VerifyErrorCode, detail: string): { ok: false; error: VerifyErrorCode; detail: string } {
  return { ok: false, error, detail }
}

/** The narrow network surface the SELLER needs to relay + finalise — adapted from a real
 *  `near-api-js` Account in index.ts so this module stays unit-testable with a plain mock. */
export interface NearRelayClient {
  /** Current FINAL block height (for the expiry check). Resolve the height, or `null` if it can't
   *  be read right now (the verifier then SKIPS expiry rather than fail-closing on a transient read). */
  currentBlockHeight(): Promise<bigint | null>
  /** Relay the signed delegate from the merchant's relayer (which prepays gas + the 1 yocto) and wait
   *  until the inner `ft_transfer` receipt has finished executing on chain. Resolve `{ txHash,
   *  innerSuccess }` — `innerSuccess` is true ONLY when the token-contract receipt itself succeeded
   *  (an outer-tx success with a failed inner receipt is `false`). THROWS on an RPC/submit failure. */
  relay(input: {
    senderId: string
    delegateAction: InstanceType<typeof DelegateAction>
    signature: unknown
  }): Promise<{ txHash: string; innerSuccess: boolean }>
}

/** Decoded `SignedDelegate` shape we read (a borsh-deserialized object; `actions[0].functionCall`
 *  carries the `ft_transfer`). Kept loose — we re-derive + re-validate every field below. */
interface RawDelegate {
  senderId?: string
  receiverId?: string
  maxBlockHeight?: bigint | number | string
  actions?: Array<{ functionCall?: { methodName?: string; args?: Uint8Array; gas?: bigint | number | string; deposit?: bigint | number | string } }>
}

type NearVerifyOutcome =
  | { ok: false; error: VerifyErrorCode; detail: string }
  | { ok: true; senderId: string; delegateAction: InstanceType<typeof DelegateAction>; signature: unknown }

/**
 * PURE — decode the base64 `SignedDelegateAction` and re-derive EVERY checked field from the TRUSTED
 * `accept` (never the client echo): exactly one `ft_transfer` FunctionCall, delegate `receiverId` =
 * the token contract (`accept.asset`), `args.receiver_id` = `payTo`, `args.amount` ≥ required, the
 * attached `deposit` = exactly 1 yocto + `gas` ≤ {@link MAX_RELAY_GAS} (the drain guard), and — when
 * `currentBlockHeight` is known — not past `max_block_height`. Returns a {@link VerifyResult}-shaped
 * `{ ok:false }` for any client-fixable fault, or the reconstructed delegate + signature for relay.
 * No network — unit-testable with a real near-api-js-built payload.
 */
export function verifyExactNear(
  payload: ExactNearPaymentPayload,
  accept: X402ExactAcceptEntry,
  currentBlockHeight: bigint | null
): NearVerifyOutcome {
  if (accept.asset === 'native' || !isValidNearAccountId(accept.asset)) {
    return fail('transfer_not_found', `NEAR exact rail asset "${accept.asset}" is not a NEP-141 contract.`)
  }
  if (typeof payload?.signedDelegateAction !== 'string') {
    return fail('signature_invalid', 'NEAR exact payload is missing signedDelegateAction.')
  }

  // C1. Borsh-decode the SignedDelegate (borsh@2 + near's SCHEMA).
  let decoded: { delegateAction?: RawDelegate; signature?: unknown }
  try {
    decoded = deserialize(SCHEMA.SignedDelegate as never, b64decode(payload.signedDelegateAction)) as never
  } catch (err) {
    return fail('signature_invalid', `Unparseable SignedDelegateAction: ${shorten(err instanceof Error ? err.message : String(err))}.`)
  }
  const da = decoded?.delegateAction
  const sig = decoded?.signature
  if (!da || sig == null) return fail('signature_invalid', 'SignedDelegateAction is missing its delegate action or signature.')

  // C2. Exactly one action, and it's a FunctionCall to `ft_transfer`.
  if (!Array.isArray(da.actions) || da.actions.length !== 1) {
    return fail('transfer_not_found', `the delegate must carry exactly one action, got ${da.actions?.length ?? 0}.`)
  }
  const fc = da.actions[0]?.functionCall
  if (!fc || fc.methodName !== 'ft_transfer') {
    return fail('transfer_not_found', `the delegated action is not an ft_transfer (got "${fc?.methodName ?? 'none'}").`)
  }

  // C3. The delegate's receiver MUST be the trusted token contract.
  if (da.receiverId !== accept.asset) {
    return fail('transfer_not_found', `delegate receiver ${da.receiverId} ≠ token contract ${accept.asset}.`)
  }

  // C4. ft_transfer args: receiver_id = payTo, amount ≥ required (re-derived from the trusted accept).
  let args: { receiver_id?: unknown; amount?: unknown }
  try {
    args = JSON.parse(Buffer.from(fc.args ?? new Uint8Array()).toString())
  } catch {
    return fail('transfer_not_found', 'the ft_transfer args are not valid JSON.')
  }
  if (args.receiver_id !== accept.payTo) {
    return fail('wrong_recipient', `ft_transfer pays ${String(args.receiver_id)}, not payTo ${accept.payTo}.`)
  }
  if (typeof args.amount !== 'string' || !/^\d+$/.test(args.amount) || BigInt(args.amount) < BigInt(accept.amount)) {
    return fail('amount_too_low', `ft_transfer pays ${String(args.amount)} of the token, required ${accept.amount}.`)
  }

  // C5. Sponsor fee-drain guard: the relayer prepays the deposit + gas, so bound BOTH.
  let deposit: bigint
  let gas: bigint
  try {
    deposit = BigInt(fc.deposit ?? 0)
    gas = BigInt(fc.gas ?? 0)
  } catch {
    return fail('signature_invalid', 'the ft_transfer has a malformed gas/deposit.')
  }
  if (deposit !== ONE_YOCTO) {
    return fail('signature_invalid', `attached deposit ${deposit} ≠ the required 1 yoctoNEAR (relayer drain guard).`)
  }
  if (gas > MAX_RELAY_GAS) {
    return fail('signature_invalid', `delegated gas ${gas} exceeds the ${MAX_RELAY_GAS} cap (relayer drain guard).`)
  }

  // C6. Expiry — reject a delegate already past its max_block_height (skip only if height unreadable).
  if (currentBlockHeight !== null) {
    let maxBlock: bigint
    try {
      maxBlock = BigInt(da.maxBlockHeight ?? 0)
    } catch {
      return fail('signature_invalid', 'the delegate has a malformed max_block_height.')
    }
    if (maxBlock <= currentBlockHeight) {
      return fail('payment_expired', `the delegate expired (max_block_height ${maxBlock} ≤ current ${currentBlockHeight}).`)
    }
  }

  // C7. Sender sanity (a LOCATOR only — provenance comes from the signature the relay verifies on chain).
  if (!da.senderId || !isValidNearAccountId(String(da.senderId))) {
    return fail('signature_invalid', `the delegate sender "${String(da.senderId)}" is not a valid NEAR account id.`)
  }

  return { ok: true, senderId: String(da.senderId), delegateAction: new DelegateAction(da as never), signature: sig }
}

/**
 * SELLER — verify an inbound NEAR `exact` payment against the trusted `accept`, then SELF-SETTLE it:
 * relay the signed delegate from the merchant's own relayer (which prepays gas + the 1 yocto) and wait
 * for the inner `ft_transfer` receipt. The trusted `accept` is the SOLE source of truth for token /
 * payTo / amount; the client's payload is only decoded + matched against it.
 *
 * RETURNS a {@link VerifyResult}: `{ ok:false, error }` for a CLIENT-fixable fault (the gate replies
 * 402 — bad/expired/oversized delegate, wrong recipient/amount, used nonce); `{ ok:true, receipt }`
 * once the inner transfer succeeds on chain. THROWS {@link SettlementError} for a SERVER-side settle
 * failure (a VALID delegate that fails to relay — relayer out of NEAR, RPC down) → the gate replies
 * 5xx and the buyer's signed delegate stays valid + re-presentable.
 */
export async function verifyAndSettleExactNear(input: {
  client: NearRelayClient
  payload: ExactNearPaymentPayload
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { client, payload, accept } = input

  // Best-effort current height for the expiry check — a transient read failure does NOT block (the
  // chain re-enforces max_block_height at submit, and the relay below fails closed on an expired one).
  let height: bigint | null = null
  try {
    height = await client.currentBlockHeight()
  } catch {
    /* unreadable → skip the local expiry pre-check; the chain still enforces it */
  }

  const v = verifyExactNear(payload, accept, height)
  if (!v.ok) return v

  let result: { txHash: string; innerSuccess: boolean }
  try {
    result = await client.relay({ senderId: v.senderId, delegateAction: v.delegateAction, signature: v.signature })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    // Client-fixable causes surfaced by the chain at relay → 402 (not a server fault).
    if (/invalid.*nonce|nonce.*used|DelegateActionInvalidNonce/i.test(m)) {
      return fail('tx_already_used', `this delegate was already used (single-use nonce): ${shorten(m)}.`)
    }
    if (/expired|DelegateActionExpired|max_block_height|deadline/i.test(m)) {
      return fail('payment_expired', `the delegate expired before it landed: ${shorten(m)}.`)
    }
    if (/not enough|insufficient|exceeded the prepaid gas|NotEnoughBalance|doesn't have enough|is not registered/i.test(m)) {
      return fail('tx_reverted', `the ft_transfer would fail on chain: ${shorten(m)}.`)
    }
    // Otherwise it's a SERVER-side settle failure — the buyer's delegate is still valid.
    throw new SettlementError(
      `NEAR exact settle: the relayer could not submit the delegate (${shorten(m)}). The buyer's signed ` +
        `delegate is still valid — fund/fix the relayer and the buyer can re-present it.`,
      { cause: err }
    )
  }

  if (!result.innerSuccess) {
    return fail('tx_reverted', `the ft_transfer receipt did not succeed on chain (tx ${result.txHash}).`)
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: result.txHash,
      asset: accept.asset,
      amount: accept.amount,
      payer: v.senderId,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
