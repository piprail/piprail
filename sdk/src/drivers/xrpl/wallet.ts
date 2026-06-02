/**
 * ── XRPL SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton/stellar
 * wallet.ts). Accepts `{ seed }` (an s… family secret seed) or a ready
 * `{ wallet }` (an xrpl.js Wallet); rejects EVM / Solana / TON / Stellar wallet
 * shapes with a clear WrongFamilyError.
 *
 * XRPL key derivation is synchronous (`Wallet.fromSeed`), so there's no async
 * step — but we still split `assert` (shape) from `resolve` (build the Wallet)
 * to mirror the other families.
 */
import { Wallet, isValidSecret } from 'xrpl'
import { WrongFamilyError } from '../../errors.js'

export interface XrplWalletConfig {
  /** An s… secret seed — the account's private key material. */
  seed?: string
  /** A ready xrpl.js Wallet, if you built it yourself. */
  wallet?: Wallet
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertXrplWallet(wallet: unknown, network: string): XrplWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; wallet must be { seed } (s… seed) or { wallet }.`
    )
  }
  if ('privateKey' in wallet || 'walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; an EVM wallet can't be used — pass { seed } (s… seed) or { wallet }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keyPair' in wallet ||
    'secret' in wallet ||
    'keypair' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; that looks like a Solana/TON/Stellar wallet — pass { seed } (s… seed) or { wallet }.`
    )
  }
  if (!('seed' in wallet) && !('wallet' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is XRPL; wallet must be { seed } (s… seed) or { wallet }.`
    )
  }
  return wallet as XrplWalletConfig
}

/** Build the signing Wallet from the validated config. */
export function resolveXrplWallet(config: XrplWalletConfig): Wallet {
  if (config.wallet) return config.wallet
  if (config.seed) {
    if (!isValidSecret(config.seed)) {
      throw new WrongFamilyError('XRPL wallet { seed } is not a valid s… secret seed.')
    }
    return Wallet.fromSeed(config.seed)
  }
  throw new WrongFamilyError('XRPL wallet needs { seed } (s… seed) or { wallet }.')
}
