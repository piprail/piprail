import {
  erc20Abi,
  type Account,
  type Chain,
  type Hex,
  type WalletClient,
} from 'viem'
import type { X402AcceptEntry } from '../../x402.js'

/**
 * ── EVM SECTION: pay ──
 * Broadcast the payment transaction for a challenge accept and return its
 * hash. The caller waits for confirmations separately (in the driver's
 * confirm()).
 *
 * Two branches, nothing more:
 *   - native asset → walletClient.sendTransaction(to: payTo, value: amount)
 *   - ERC-20 asset → token.transfer(payTo, amount)
 *
 * A plain transfer is all the verifier checks for, so this is all the
 * client needs to do. Works on any EVM chain.
 */
export type PayEvmParams = {
  walletClient: WalletClient
  account: Account
  chain: Chain
  accept: X402AcceptEntry
}

export async function payEvm(input: PayEvmParams): Promise<Hex> {
  const { walletClient, account, chain, accept } = input
  const amount = BigInt(accept.amount)
  const payTo = accept.payTo as `0x${string}`

  if (accept.asset === 'native') {
    return walletClient.sendTransaction({
      account,
      chain,
      to: payTo,
      value: amount,
    })
  }

  return walletClient.writeContract({
    account,
    chain,
    address: accept.asset as `0x${string}`,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [payTo, amount],
  })
}
