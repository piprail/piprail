/**
 * ── EVM SECTION: wallet ──
 * Validate + wrap the agent's wallet config into a viem account + `WalletClient`
 * over the resolved chain. Accepts `{ privateKey }` (a 0x… hex key — the SDK
 * builds the client) or a ready `{ walletClient }` (bring-your-own, with an
 * attached account); rejects a chain-mismatched or account-less client with a
 * clear WrongChainError / WrongFamilyError.
 */
import {
  createWalletClient,
  http,
  type WalletClient,
  type Account,
  type Hex,
  type Transport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type ResolvedChain } from './chains.js'
import { WrongChainError, WrongFamilyError } from '../../errors.js'

export interface WalletAdapter {
  account: Account
  walletClient: WalletClient
}

export type WalletConfig =
  | { privateKey: Hex }
  | { walletClient: WalletClient }

/**
 * Wrap the agent's wallet config into a viem account + walletClient (the
 * driver builds its own publicClient for reads).
 *
 *   - `{ privateKey }`  : headless agent — the SDK builds the walletClient.
 *   - `{ walletClient }`: bring-your-own — a walletClient with an attached
 *     account (MetaMask via viem's `custom(...)` transport, etc.).
 */
export function createWalletAdapter(
  config: WalletConfig,
  resolved: ResolvedChain
): WalletAdapter {
  if ('privateKey' in config) {
    const account = privateKeyToAccount(config.privateKey)
    const transport: Transport = http(resolved.rpcUrl)
    const walletClient = createWalletClient({ account, chain: resolved.chain, transport })
    return { account, walletClient }
  }

  const wc = config.walletClient
  if (!wc.account) {
    throw new WrongFamilyError(
      'chain is EVM; the provided walletClient has no attached account. ' +
        'Use `createWalletClient({ account, chain, transport })`, or pass { privateKey }.'
    )
  }
  // Catch the silent footgun of a walletClient pointed at the wrong chain.
  if (wc.chain && wc.chain.id !== resolved.chainId) {
    throw new WrongChainError(
      `PipRailClient: walletClient is on chain ${wc.chain.id} but the SDK ` +
        `was configured with chain ${resolved.chainId}. They must match.`
    )
  }
  return { account: wc.account, walletClient: wc }
}
