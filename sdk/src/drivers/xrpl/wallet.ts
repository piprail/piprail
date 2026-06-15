/**
 * ── XRPL SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton/stellar
 * wallet.ts). Accepts `{ key }` (an s… family secret seed) or a ready
 * `{ wallet }` (an xrpl.js Wallet); rejects pre-v2 wallet shapes with a clear
 * WrongFamilyError.
 *
 * XRPL key derivation is synchronous (`Wallet.fromSeed`), so there's no async
 * step — but we still split `assert` (shape) from `resolve` (build the Wallet)
 * to mirror the other families.
 */
import { Wallet, isValidSecret } from 'xrpl'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface XrplWalletConfig {
  /** An s… secret seed — the account's private key material. */
  key?: string
  /** A ready xrpl.js Wallet, if you built it yourself. */
  wallet?: Wallet
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertXrplWallet(wallet: unknown, network: string): XrplWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; wallet must be { key } (s… seed) or { wallet }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'XRPL')
  if (!('key' in wallet) && !('wallet' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; wallet must be { key } (s… seed) or { wallet }.`
    )
  }
  return wallet as XrplWalletConfig
}

/** Build the signing Wallet from the validated config. */
export function resolveXrplWallet(config: XrplWalletConfig): Wallet {
  if (config.wallet) return config.wallet
  if (config.key) {
    if (!isValidSecret(config.key)) {
      throw new WrongFamilyError('XRPL wallet { key } is not a valid s… secret seed.')
    }
    return Wallet.fromSeed(config.key)
  }
  throw new WrongFamilyError('XRPL wallet needs { key } (s… seed) or { wallet }.')
}
