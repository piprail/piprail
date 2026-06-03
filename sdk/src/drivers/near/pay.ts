/**
 * ── NEAR SECTION: pay ──
 * Send a NEP-141 `ft_transfer` to `payTo`, with the challenge nonce in the
 * `memo` arg — Template A binding — and return the tx hash.
 *
 * Two NEAR specifics baked in: the transfer attaches exactly **1 yoctoNEAR**
 * (mandatory anti-phishing deposit) and ~30 TGas (plenty). Amounts are integer
 * base units (6dp), so `accept.amount` goes verbatim.
 *
 * **Intents trap (do NOT "upgrade" this):** NEAR's x402 marketing leans on
 * cross-chain Intents/solvers — an orchestration layer that re-introduces a
 * third-party facilitator. A plain `ft_transfer` + local receipt verification is
 * fully viable and is what we do; never route this through Intents/solvers.
 *
 * The signer is injected behind a narrow client so this is unit-testable; the
 * near-api-js Account wiring lives in index.ts.
 */
import {
  InsufficientFundsError,
  RecipientNotReadyError,
  toInsufficientFundsError,
} from '../../errors.js'
import type { X402AcceptEntry } from '../../x402.js'

/** The calls the pay path needs — adapted from a near-api-js Account in index.ts. */
export interface NearSendClient {
  ftTransfer(input: {
    contractId: string
    receiverId: string
    amount: string
    memo: string
    gas: bigint
    deposit: bigint
  }): Promise<{ hash: string }>
  /** A plain native-NEAR `Transfer` to `receiverId` (yoctoNEAR). No memo, no
   *  storage_deposit — a native transfer even creates a fresh implicit recipient. */
  nativeTransfer(input: { receiverId: string; amount: string }): Promise<{ hash: string }>
}

export interface PayNearParams {
  client: NearSendClient
  accept: X402AcceptEntry
  /** Gas override (default 30 TGas). */
  gas?: bigint
}

/** 30 TGas — comfortably covers an ft_transfer. */
const FT_TRANSFER_GAS = 30_000_000_000_000n
/** ft_transfer mandates exactly 1 yoctoNEAR attached (anti-phishing). */
const ONE_YOCTO = 1n

export async function payNear(params: PayNearParams): Promise<string> {
  const { client, accept, gas } = params
  try {
    const res = await client.ftTransfer({
      contractId: accept.asset,
      receiverId: accept.payTo,
      amount: accept.amount,
      memo: accept.extra.nonce, // nonce binding (Template A)
      gas: gas ?? FT_TRANSFER_GAS,
      deposit: ONE_YOCTO,
    })
    return res.hash
  } catch (err) {
    // A merchant that isn't NEP-145-registered makes ft_transfer panic — that's a
    // RECIPIENT setup problem (not the payer's balance), so surface the typed,
    // actionable RecipientNotReadyError.
    if (isNearRegistrationError(err)) {
      throw new RecipientNotReadyError(
        `NEAR recipient ${accept.payTo} isn't registered on token ${accept.asset} ` +
          `(NEP-145 storage_deposit) — register it once (≈0.00125 NEAR) before it can receive. (NEAR: not registered)`,
        { cause: err }
      )
    }
    // Map NEAR's affordability phrasings to the SAME typed error as every chain.
    if (isNearAffordability(err)) {
      throw new InsufficientFundsError(
        err instanceof Error ? err.message : 'Insufficient NEAR balance for the payment.',
        { cause: err }
      )
    }
    throw toInsufficientFundsError(err) ?? err
  }
}

/**
 * Pay in NATIVE NEAR — a single `Transfer` action (digest-bound, like EVM/Solana/Sui).
 * No memo, no 1-yoctoNEAR deposit, and no NEP-145 `storage_deposit`: a native transfer
 * credits any account and even creates a fresh implicit recipient. The proof is the tx
 * hash; the gate's single-use set + the verifier's recency window are what bind it.
 */
export async function payNearNative(params: {
  client: NearSendClient
  accept: X402AcceptEntry
}): Promise<string> {
  const { client, accept } = params
  try {
    const res = await client.nativeTransfer({ receiverId: accept.payTo, amount: accept.amount })
    return res.hash
  } catch (err) {
    if (isNearAffordability(err)) {
      throw new InsufficientFundsError(
        err instanceof Error ? err.message : 'Insufficient NEAR balance for the payment.',
        { cause: err }
      )
    }
    throw toInsufficientFundsError(err) ?? err
  }
}

/** NEAR errors that mean "the recipient isn't storage-registered on the token". */
function isNearRegistrationError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /not registered|storage_?deposit|The account .* is not registered/i.test(m)
}

/** NEAR errors that mean "the wallet can't afford it" (token balance, gas, or deposit). */
function isNearAffordability(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /not enough|doesn't have enough|does not have enough|lack ?balance|exceeds .*balance|insufficient/i.test(m)
}
