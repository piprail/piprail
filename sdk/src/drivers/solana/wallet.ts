/**
 * ── SOLANA SECTION: wallet ──
 * Validate + wrap the agent's wallet config into a Solana `Keypair` (mirrors
 * evm/wallet.ts). Accepts `{ key }` (a base58 secret string or a `Uint8Array`)
 * or a ready `{ signer }` Keypair; rejects EVM wallet shapes with a clear
 * `WrongFamilyError`.
 */
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export function toKeypair(wallet: unknown, network: string): Keypair {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Solana; wallet must be { key } (base58 secret) or { signer }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Solana')
  if ('signer' in wallet) {
    return (wallet as { signer: Keypair }).signer
  }
  if ('key' in wallet) {
    const sk = (wallet as { key: Uint8Array | string }).key
    const bytes = typeof sk === 'string' ? bs58.decode(sk) : sk
    return Keypair.fromSecretKey(bytes)
  }
  throw new WrongFamilyError(
    `chain ${network} is Solana; wallet must be { key } (base58 secret) or { signer }.`
  )
}
