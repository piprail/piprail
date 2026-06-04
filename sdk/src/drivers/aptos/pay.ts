/**
 * ── APTOS SECTION: pay ──
 * Build, sign, and submit an Aptos transaction that transfers the asset to
 * `payTo`, returning the tx hash.
 *
 * ONE path for every asset — native APT and the stablecoins are all Fungible
 * Assets, so all transfer via `0x1::primary_fungible_store::transfer`
 * (typeArg `0x1::fungible_asset::Metadata`, args `[metadata, payTo, amount]`).
 * Native uses the APT FA metadata (`0xa`). `primary_fungible_store::transfer`
 * auto-creates the recipient's primary store, so there's no opt-in / coin-store
 * registration to receive — even a fresh recipient works.
 *
 * Template B (digest-bound, like Sui/EVM/Solana): no memo — the proof IS the tx
 * hash; binding comes from single-use + recipient + amount + metadata + recency.
 * Aptos amounts are integer base units (u64), so `accept.amount` goes verbatim.
 *
 * The client is injected behind a narrow interface so this is unit-testable with
 * a mock; signing is offline via the Account.
 */
import { InsufficientFundsError, toInsufficientFundsError } from '../../errors.js'
import { APT_FA_METADATA } from './chains.js'
import type { X402AcceptEntry } from '../../x402.js'

/** A Move entry-function call (pure data — no SDK types). */
export interface AptosEntryData {
  function: `${string}::${string}::${string}`
  typeArguments: string[]
  functionArguments: unknown[]
}

/** The slice of the Aptos client the pay path needs — adapted from a real client in index.ts. */
export interface AptosPayClient {
  /** Build a simple (single-signer) transaction from an entry-function payload. */
  build(input: { sender: string; data: AptosEntryData }): Promise<unknown>
  /** Sign + submit the built transaction, returning the pending tx hash. */
  signSubmit(input: { signer: unknown; transaction: unknown }): Promise<{ hash: string }>
}

export interface PayAptosParams {
  client: AptosPayClient
  /** The signing Account (opaque to this module). */
  signer: unknown
  /** The payer's address (the Account's address). */
  sender: string
  accept: X402AcceptEntry
}

export async function payAptos(params: PayAptosParams): Promise<string> {
  const { client, signer, sender, accept } = params
  const metadata = accept.asset === 'native' ? APT_FA_METADATA : accept.asset
  try {
    const transaction = await client.build({
      sender,
      data: {
        function: '0x1::primary_fungible_store::transfer',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        // u64 amount goes as a base-unit string; the FA metadata object + recipient are addresses.
        functionArguments: [metadata, accept.payTo, accept.amount],
      },
    })
    const res = await client.signSubmit({ signer, transaction })
    return res.hash
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err
    if (isAptosAffordability(err)) {
      throw new InsufficientFundsError(
        err instanceof Error ? err.message : 'Insufficient APT/token balance for the payment.',
        { cause: err }
      )
    }
    throw toInsufficientFundsError(err) ?? err
  }
}

/** Aptos error shapes that mean "the wallet can't afford it" (gas or token balance). */
function isAptosAffordability(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /INSUFFICIENT_BALANCE|EINSUFFICIENT_BALANCE|insufficient.*(balance|gas|funds)|coin store|balance is too low|EINSUFFICIENT/i.test(
    m
  )
}
