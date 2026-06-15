/**
 * ── EVM SECTION: wallet ──
 * Validate + wrap the agent's wallet config into a viem account + `WalletClient`
 * over the resolved chain. Accepts `{ key }` (a 0x… hex private key — the SDK
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
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface WalletAdapter {
  account: Account
  walletClient: WalletClient
}

export type WalletConfig =
  | { key: string }
  | { walletClient: WalletClient }

/**
 * Wrap the agent's wallet config into a viem account + walletClient (the
 * driver builds its own publicClient for reads).
 *
 *   - `{ key }`         : headless agent — a 0x… hex private key; the SDK builds the walletClient.
 *   - `{ walletClient }`: bring-your-own — a walletClient with an attached
 *     account (MetaMask via viem's `custom(...)` transport, etc.).
 */
export function createWalletAdapter(
  config: WalletConfig,
  resolved: ResolvedChain
): WalletAdapter {
  assertNoLegacyWalletKey(config, 'EVM')
  if ('key' in config) {
    const key = config.key
    // Validate the shape before viem so a wrong-family / fat-fingered key gives a
    // clear typed WrongFamilyError, not a raw viem "invalid private key" leak
    // (mirrors solana/wallet.ts, near/wallet.ts).
    if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      const hint =
        typeof key === 'string' && !key.startsWith('0x')
          ? " (got a non-0x string — a base58/seed key belongs to another family; pass { key } as the EVM chain's 0x… hex secret)."
          : ' (expected 0x followed by 64 hex characters).'
      throw new WrongFamilyError(
        `chain is EVM; the wallet { key } is not a valid 0x… 32-byte hex private key${hint}`
      )
    }
    let account
    try {
      account = privateKeyToAccount(key as Hex)
    } catch (err) {
      throw new WrongFamilyError(
        'chain is EVM; the wallet { key } is not a valid 0x… 32-byte hex private key: ' +
          `${err instanceof Error ? err.message : String(err)}.`
      )
    }
    const transport: Transport = http(resolved.rpcUrl)
    const walletClient = createWalletClient({ account, chain: resolved.chain, transport })
    return { account, walletClient }
  }

  const wc = config.walletClient
  if (!wc.account) {
    throw new WrongFamilyError(
      'chain is EVM; the provided walletClient has no attached account. ' +
        'Use `createWalletClient({ account, chain, transport })`, or pass { key }.'
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
