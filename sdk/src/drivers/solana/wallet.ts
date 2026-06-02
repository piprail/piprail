/**
 * ── SOLANA SECTION: wallet ──
 * Validate + wrap the agent's wallet config into a Solana `Keypair` (mirrors
 * evm/wallet.ts). Accepts `{ secretKey }` (a `Uint8Array` or base58 string)
 * or a ready `{ signer }` Keypair; rejects EVM wallet shapes with a clear
 * `WrongFamilyError`.
 */
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { WrongFamilyError } from '../../errors.js'

export function toKeypair(wallet: unknown, network: string): Keypair {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Solana; wallet must be { secretKey } or { signer }.`
    )
  }
  if ('privateKey' in wallet || 'walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Solana; an EVM wallet can't be used — pass { secretKey } or { signer }.`
    )
  }
  if ('signer' in wallet) {
    return (wallet as { signer: Keypair }).signer
  }
  if ('secretKey' in wallet) {
    const sk = (wallet as { secretKey: Uint8Array | string }).secretKey
    const bytes = typeof sk === 'string' ? bs58.decode(sk) : sk
    return Keypair.fromSecretKey(bytes)
  }
  throw new WrongFamilyError(
    `chain ${network} is Solana; wallet must be { secretKey } or { signer }.`
  )
}
