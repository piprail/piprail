/**
 * ── SUI SECTION: pay ──
 * Build, sign, and execute a Sui programmable transaction (PTB) that transfers
 * the asset to `payTo`, returning the tx digest.
 *   - native SUI → split from the gas coin, transfer to payTo
 *   - Coin<USDC> → fetch the payer's coin objects, merge + split, transfer to payTo
 *
 * Template B (digest-bound, like EVM/Solana): no memo — the proof IS the digest;
 * binding comes from single-use + recipient + amount + coinType + recency.
 * Sui amounts are integer base units (u64), so `accept.amount` goes verbatim.
 *
 * The client is injected behind a narrow interface so this is unit-testable with
 * a mock; signing is offline via the Ed25519Keypair.
 */
import { Transaction } from '@mysten/sui/transactions'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { InsufficientFundsError, toInsufficientFundsError } from '../../errors.js'
import type { X402AcceptEntry } from '../../x402.js'

/** The slice of SuiJsonRpcClient the pay path needs — adapted from a real client in index.ts. */
export interface SuiPayClient {
  getCoins(input: { owner: string; coinType: string }): Promise<{ data: { coinObjectId: string }[] }>
  signAndExecuteTransaction(input: {
    signer: Ed25519Keypair
    transaction: Transaction
    options?: { showEffects?: boolean }
  }): Promise<{ digest: string }>
}

export interface PaySuiParams {
  client: SuiPayClient
  keypair: Ed25519Keypair
  accept: X402AcceptEntry
}

export async function paySui(params: PaySuiParams): Promise<string> {
  const { client, keypair, accept } = params
  const sender = keypair.getPublicKey().toSuiAddress()
  const amount = BigInt(accept.amount)
  try {
    const tx = new Transaction()
    tx.setSender(sender)

    if (accept.asset === 'native') {
      const [coin] = tx.splitCoins(tx.gas, [amount])
      tx.transferObjects([coin], accept.payTo)
    } else {
      const coins = await client.getCoins({ owner: sender, coinType: accept.asset })
      if (!coins.data.length) {
        throw new InsufficientFundsError(
          `Sui wallet holds no ${accept.asset} coin objects to pay from.`
        )
      }
      const ids = coins.data.map((c) => c.coinObjectId)
      const primary = ids[0]!
      if (ids.length > 1) {
        tx.mergeCoins(tx.object(primary), ids.slice(1).map((id) => tx.object(id)))
      }
      const [coin] = tx.splitCoins(tx.object(primary), [amount])
      tx.transferObjects([coin], accept.payTo)
    }

    const res = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    })
    return res.digest
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err
    if (isSuiAffordability(err)) {
      throw new InsufficientFundsError(
        err instanceof Error ? err.message : 'Insufficient SUI/coin balance for the payment.',
        { cause: err }
      )
    }
    throw toInsufficientFundsError(err) ?? err
  }
}

/** Sui error shapes that mean "the wallet can't afford it" (gas or coin balance). */
function isSuiAffordability(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /no valid gas|gas.*(balance|coin)|insufficient|balance is too low|GasBalanceTooLow/i.test(m)
}
